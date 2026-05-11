const BULK_API_VERSION = "v59.0";
const SESSION_COOKIE_NAME = "sid";
const BULK_JOB_POLL_INTERVAL_MS = 4000;
const WEB_SESSION_WARMUP_DELAY_MS = 2500;
const WEB_SESSION_WARMUP_PATH = "/home/home.jsp";

const queryParams = new URLSearchParams(window.location.search);
const launchContext = {
  instanceUrl: queryParams.get("instance"),
  launchError: queryParams.get("error")
};

const ui = {
  queryInput: document.getElementById("soql"),
  runButton: document.getElementById("run"),
  progressBar: document.getElementById("progressBar"),
  statusText: document.getElementById("status")
};

initializeApp();

function initializeApp() {
  if (launchContext.launchError) {
    renderLaunchMessage(launchContext.launchError);
    return;
  }

  if (!launchContext.instanceUrl) {
    renderLaunchMessage("Invalid launch. Open SF Export from a Salesforce page.");
    return;
  }

  setProgress(0);
  setStatus("Ready to export.");
  ui.runButton.addEventListener("click", handleExportClick);
}

function renderLaunchMessage(message) {
  document.body.innerHTML = `<h3>${message}</h3>`;
}

function setStatus(message) {
  ui.statusText.innerText = message;
}

function setProgress(percent) {
  const safePercent = Math.max(0, Math.min(100, percent));
  ui.progressBar.style.width = `${safePercent}%`;
  ui.progressBar.innerText = `${safePercent}%`;
}

function setExportRunning(isRunning) {
  ui.runButton.disabled = isRunning;
}

function getSoqlQuery() {
  return ui.queryInput.value.trim();
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function buildSalesforceBaseCandidates(instanceUrl) {
  if (!instanceUrl) {
    return [];
  }

  const parsedUrl = new URL(instanceUrl);
  const { protocol, hostname } = parsedUrl;

  if (hostname.endsWith(".lightning.force.com")) {
    return [
      `${protocol}//${hostname.replace(/\.lightning\.force\.com$/, ".my.salesforce.com")}`,
      `${protocol}//${hostname.replace(/\.lightning\.force\.com$/, ".salesforce.com")}`
    ];
  }

  if (hostname.endsWith(".salesforce-setup.com")) {
    return [
      `${protocol}//${hostname.replace(/\.salesforce-setup\.com$/, ".my.salesforce.com")}`,
      `${protocol}//${hostname.replace(/\.salesforce-setup\.com$/, ".salesforce.com")}`
    ];
  }

  return [parsedUrl.origin];
}

function requiresWebSessionWarmup(instanceUrl) {
  if (!instanceUrl) {
    return false;
  }

  const hostname = new URL(instanceUrl).hostname;
  return (
    hostname.endsWith(".lightning.force.com") ||
    hostname.endsWith(".salesforce-setup.com")
  );
}

function getCookieForUrl(url, cookieName) {
  return new Promise((resolve, reject) => {
    chrome.cookies.get({ url, name: cookieName }, cookie => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      resolve(cookie);
    });
  });
}

async function findSessionContext(candidateBaseUrls) {
  for (const baseUrl of candidateBaseUrls) {
    const sessionCookie = await getCookieForUrl(baseUrl, SESSION_COOKIE_NAME);

    if (sessionCookie?.value) {
      return {
        sessionId: sessionCookie.value,
        apiBaseUrl: baseUrl
      };
    }
  }

  return null;
}

function warmUpWebSession(baseUrl) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(
      {
        url: `${baseUrl}${WEB_SESSION_WARMUP_PATH}`,
        active: false
      },
      createdTab => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (!createdTab || typeof createdTab.id !== "number") {
          reject(new Error("Unable to prepare Salesforce web session."));
          return;
        }

        const { id: tabId } = createdTab;

        setTimeout(() => {
          chrome.tabs.remove(tabId, () => {
            resolve();
          });
        }, WEB_SESSION_WARMUP_DELAY_MS);
      }
    );
  });
}

async function resolveSessionContext(instanceUrl) {
  const candidateBaseUrls = buildSalesforceBaseCandidates(instanceUrl);
  let sessionContext = await findSessionContext(candidateBaseUrls);

  if (sessionContext) {
    return sessionContext;
  }

  // Lightning and Setup pages may not expose the web-session cookie until
  // Salesforce has opened a classic/web page at least once in the browser.
  if (requiresWebSessionWarmup(instanceUrl) && candidateBaseUrls.length > 0) {
    setStatus("Preparing Salesforce web session...");
    await warmUpWebSession(candidateBaseUrls[0]);
    sessionContext = await findSessionContext(candidateBaseUrls);
  }

  if (!sessionContext) {
    throw new Error("Salesforce session cookie not found.");
  }

  return sessionContext;
}

async function sendSalesforceRequest(url, sessionId, options = {}) {
  const requestHeaders = {
    Authorization: `Bearer ${sessionId}`,
    ...(options.headers || {})
  };

  const response = await fetch(url, {
    ...options,
    headers: requestHeaders
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  return response;
}

async function createBulkQueryJob(sessionId, apiBaseUrl, soqlQuery) {
  const response = await sendSalesforceRequest(
    `${apiBaseUrl}/services/data/${BULK_API_VERSION}/jobs/query`,
    sessionId,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        operation: "query",
        query: soqlQuery,
        contentType: "CSV"
      })
    }
  );

  const jobData = await response.json();
  return jobData.id;
}

async function waitForJobCompletion(sessionId, apiBaseUrl, jobId) {
  while (true) {
    const response = await sendSalesforceRequest(
      `${apiBaseUrl}/services/data/${BULK_API_VERSION}/jobs/query/${jobId}`,
      sessionId
    );

    const jobData = await response.json();

    if (jobData.state === "JobComplete") {
      return;
    }

    if (jobData.state === "Failed" || jobData.state === "Aborted") {
      throw new Error(`Bulk job ended with status: ${jobData.state}.`);
    }

    setStatus(`Processing... ${jobData.numberRecordsProcessed.toLocaleString()} records`);
    await wait(BULK_JOB_POLL_INTERVAL_MS);
  }
}

async function countResultChunks(sessionId, apiBaseUrl, jobId) {
  let locator = null;
  let chunkCount = 0;

  do {
    const resultsUrl = locator
      ? `${apiBaseUrl}/services/data/${BULK_API_VERSION}/jobs/query/${jobId}/results?locator=${locator}`
      : `${apiBaseUrl}/services/data/${BULK_API_VERSION}/jobs/query/${jobId}/results`;

    // Bulk API 2.0 exposes the next chunk via the locator header, so a HEAD
    // request lets us count result parts without downloading them yet.
    const response = await sendSalesforceRequest(resultsUrl, sessionId, {
      method: "HEAD"
    });

    locator = response.headers.get("Sforce-Locator");
    chunkCount += 1;
  } while (locator && locator !== "null");

  return chunkCount;
}

async function downloadResultChunks(sessionId, apiBaseUrl, jobId, jobFolder, totalChunks) {
  let locator = null;
  let currentChunk = 0;

  do {
    currentChunk += 1;

    const resultsUrl = locator
      ? `${apiBaseUrl}/services/data/${BULK_API_VERSION}/jobs/query/${jobId}/results?locator=${locator}`
      : `${apiBaseUrl}/services/data/${BULK_API_VERSION}/jobs/query/${jobId}/results`;

    setStatus(`Downloading part ${currentChunk} of ${totalChunks}...`);

    const response = await sendSalesforceRequest(resultsUrl, sessionId);
    const fileHandle = await jobFolder.getFileHandle(`part_${currentChunk}.csv`, {
      create: true
    });

    const writableStream = await fileHandle.createWritable();
    await response.body.pipeTo(writableStream);

    locator = response.headers.get("Sforce-Locator");
    setProgress(Math.floor((currentChunk / totalChunks) * 100));
  } while (locator && locator !== "null");
}

async function handleExportClick() {
  const soqlQuery = getSoqlQuery();

  if (!soqlQuery) {
    alert("Please enter a SOQL query.");
    return;
  }

  setExportRunning(true);
  setProgress(0);

  try {
    setStatus("Reading Salesforce session...");
    const { sessionId, apiBaseUrl } = await resolveSessionContext(launchContext.instanceUrl);

    setStatus("Choose destination folder (Desktop recommended)...");
    const rootDirectory = await window.showDirectoryPicker();

    setStatus("Creating Bulk job...");
    const jobId = await createBulkQueryJob(sessionId, apiBaseUrl, soqlQuery);
    const jobFolder = await rootDirectory.getDirectoryHandle(jobId, { create: true });

    setStatus("Processing query...");
    await waitForJobCompletion(sessionId, apiBaseUrl, jobId);

    setStatus("Preparing chunk list...");
    const totalChunks = await countResultChunks(sessionId, apiBaseUrl, jobId);

    setStatus(`Found ${totalChunks} chunks. Starting download...`);
    await downloadResultChunks(sessionId, apiBaseUrl, jobId, jobFolder, totalChunks);

    setProgress(100);
    setStatus("Export completed successfully.");
  } catch (error) {
    setStatus(`Error: ${error.message || error}`);
  } finally {
    setExportRunning(false);
  }
}

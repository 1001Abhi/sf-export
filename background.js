const APP_PAGE_PATH = "app.html";
const SUPPORTED_SALESFORCE_HOST_SUFFIXES = [
  ".salesforce.com",
  ".my.salesforce.com",
  ".lightning.force.com",
  ".salesforce-setup.com",
  ".force.com"
];

function isSupportedSalesforcePage(url) {
  if (!url) {
    return false;
  }

  const hostname = new URL(url).hostname;
  return SUPPORTED_SALESFORCE_HOST_SUFFIXES.some(hostSuffix => hostname.endsWith(hostSuffix));
}

function buildAppPageUrl(searchParams = {}) {
  const appUrl = new URL(chrome.runtime.getURL(APP_PAGE_PATH));

  Object.entries(searchParams).forEach(([key, value]) => {
    appUrl.searchParams.set(key, value);
  });

  return appUrl.toString();
}

chrome.action.onClicked.addListener(activeTab => {
  if (!activeTab.url || !isSupportedSalesforcePage(activeTab.url)) {
    chrome.tabs.create({
      url: buildAppPageUrl({
        error: "Please open this extension from a Salesforce page."
      })
    });
    return;
  }

  chrome.tabs.create({
    url: buildAppPageUrl({
      instance: new URL(activeTab.url).origin
    })
  });
});

# SF Export

SF Export is a Chrome extension for running Salesforce Bulk API 2.0 query exports and saving the results locally as CSV files.

## What it does

- Reads the active Salesforce browser session
- Creates a Bulk API 2.0 query job from your SOQL query
- Waits for Salesforce to finish processing the export
- Detects how many result chunks are available
- Downloads each chunk as a separate CSV file

## How to use

1. Open any Salesforce page in Chrome.
2. Click the `SF Export` extension icon.
3. Enter your SOQL query.
4. Click `Start Export`.
5. Choose the folder where you want to save the files.

## Example query

```sql
SELECT Id, Name FROM Account
```

## How chunked downloads work

Salesforce Bulk API 2.0 can return large query results in multiple parts instead of one single file.

SF Export handles that automatically and saves files like:

- `part_1.csv`
- `part_2.csv`
- `part_3.csv`

## Installation

1. Clone this repository.
2. Open `chrome://extensions`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select this project folder.

## Notes

- Launch the extension from a Salesforce page.
- The extension uses your current browser session. There is no separate login flow.
- For Lightning Experience and Setup pages, the extension can warm up the matching web session before reading the `sid` cookie.

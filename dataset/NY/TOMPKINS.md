[page][goto] https://countyfusion3.govos.com/countyweb/loginDisplay.action?countyname=Tompkins
[page][waitfor] 2000
[stagehand][observe] find `Login as Guest` or `Login as Public` button
[stagehand][act] click `Login as Guest` or `Login as Public` button
[page][waitfor] 5000
[stagehand][observe] find `Accept` button
[page][clickinsideframe] bodyframe | input#accept
[page][waitfor] 2000
[page][clickselector] #dialog img[src*="close.gif"]
[stagehand][act] click `Search Public Records` option under `What would you like to do today?`
[page][waitfor] 5000
[stagehand][act] uncheck All Document Types Document Types section
[stagehand][act] check only DEED in the Document Types section
[stagehand][act] under `Specific Criteria` type `${query.lastFirstName}` into the `Name` field
[stagehand][act] click `Search` button
[stagehand][observe] find search results table
[page][waitfor] 5000
[stagehand][act] in the search results table, find the row with the most recent Recorded date where the address below it contains `${query.streetAddress}` and Doc Type is `DEED`, then click the Control # link in that row
[page][waitfor] 2000
[stagehand][catchpdfurl]
[stagehand][act] click `Save Image`
[page][waitfor] 3000
[stagehand][act] click `Download` button in the dialog
[stagehand][downloadcaughtpdf] ./downloads/${query.propertyId}/deed.pdf

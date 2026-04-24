[page][goto] https://countyfusion5.kofiletech.us/countyweb/loginDisplay.action?countyname=Franklin
[page][waitfor] 2000
[stagehand][observe] find `Login as Guest` or `Login as Public` button
[stagehand][act] click `Login as Guest` or `Login as Public` button
[page][waitfor] 5000
[stagehand][observe] find `Accept` button
[page][clickinsideframe] bodyframe | input#accept
[page][waitfor] 2000
[page][clickselector] #dialog img[src*="close.gif"]
[stagehand][act] click `Search Public Records` option under `What would you like to do today?`
[page][waitfor] 3000
[stagehand][observe] find `Specific Criteria` section
[stagehand][act] under `Specific Criteria` type `${query.lastFirstName}` into the `Name` field
[stagehand][act] click `Search` button
[stagehand][observe] find search results table
[page][waitfor] 5000
[page][clicklinkbyrowtext] ${query.book} && ${query.page} | resultListFrame
[page][waitfor] 2000
[stagehand][catchpdfurl]
[stagehand][act] click `Save Image`
[page][waitfor] 3000
[stagehand][act] click `Download` button in the dialog
[stagehand][downloadcaughtpdf] ./downloads/${query.propertyId}/deed.pdf

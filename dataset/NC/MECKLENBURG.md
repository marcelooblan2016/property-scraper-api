[page][goto] https://meckrod.manatron.com/
[stagehand][act] click the `Click here to acknowledge disclaimer` link
[page][goto] https://meckrod.manatron.com/RealEstate/SearchEntry.aspx
[stagehand][act] fill `Party Name` input field under `Combined Name Search` radio button `${query.ownerLastName} ${query.ownerFirstName}`
[stagehand][act] fill `Book` input field `${query.book}`
[stagehand][act] fill `Page` input field `${query.page}`
[stagehand][act] click the `Search` button above the form
[stagehand][observe] the search results appear
[stagehand][act] find the URL of the `View` link in the first row of the the search results and click it
[page][goto] https://meckrod.manatron.com/RealEstate/SearchImage.aspx
[stagehand][catchpdfurl]
[stagehand][act] select the "Free Clean copy" radio button
[stagehand][act] click the `Get Image Now` button
[stagehand][observe] the PDF viewer has loaded
[stagehand][downloadcaughtpdf] ./downloads/${query.propertyId}/deed.pdf

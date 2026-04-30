[page][goto] https://apps.dutchessny.gov/County-Clerk-Document-Search/Search.aspx
[stagehand][observe] find search form
[if query.isBusinessName==='true']
[stagehand][act] click the `Business:` radio button
[stagehand][act] type `${query.ownerLastName}` into the Name (Last First) field
[else]
[stagehand][act] type `${query.ownerLastName} ${query.ownerFirstName}` into the Name (Last First) field
[endif]
[stagehand][act] type `${query.book}` into the Liber field
[stagehand][act] type `${query.page}` into the Page field
[stagehand][act] click Search
[stagehand][observe] find search results
[page][waitfor] 3000
[page][clickselector] a.view-document-image-icon
[stagehand][observe] the PDF viewer has loaded
[page][downloadiframesrc] ./downloads/${query.propertyId}/deed.pdf

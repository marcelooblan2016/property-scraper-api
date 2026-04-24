[page][goto] https://apps.dutchessny.gov/County-Clerk-Document-Search/Search.aspx
[stagehand][observe] find search form
[stagehand][act] type `${query.ownerLastName} ${query.ownerFirstName}` into the Name (Last First) field
[stagehand][act] type `${query.book}` into the Liber field
[stagehand][act] type `${query.page}` into the Page field
[stagehand][act] click Search
[stagehand][observe] find search results
[page][clickselector] a.view-document-image-icon
[stagehand][observe] the PDF viewer has loaded
[stagehand][downloadiframesrc] ./downloads/${query.propertyId}/deed.pdf

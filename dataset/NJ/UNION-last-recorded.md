[page][goto] https://clerk.ucnj.org/UCPA/DocIndex?s=name
[stagehand][observe] find search field
[if query.isBusinessName==='true']
[stagehand][act] type `${query.ownerLastName}` into the Last Name field
[else]
[stagehand][act] type `${query.ownerLastName}` into the Last Name field
[stagehand][act] type `${query.ownerFirstName}` into the First Name field
[endif]
[stagehand][act] check "Deed" on Document Types
[stagehand][act] click Search
[stagehand][observe] find search results
[stagehand][act] select row with Recorded Date: `${query.lastRecorded}` then select pdf image
[stagehand][catchpdfurl]
[stagehand][observe] the PDF viewer has loaded
[stagehand][downloadcaughtpdf] ./downloads/${query.propertyId}/deed.pdf

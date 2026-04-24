[page][goto] https://iowalandrecords.org/cas/login
[stagehand][act] type `${process.env.CREDENTIALS_IA_HAMILTON_USERNAME}` into the username field
[stagehand][act] type `${process.env.CREDENTIALS_IA_HAMILTON_PASSWORD}` into the password field
[stagehand][act] click the login button
[stagehand][observe] find Advanced Search link under Start a New Search
[page][goto] https://iowalandrecords.org/search/guided/advanced?documentType=5&documentType=7&documentType=16&documentType=26&dateRange=NONE
[stagehand][observe] find the Advanced Search form
[stagehand][act] if `${query.isBusinessName}` is `true`, type `${query.ownerLastName}` into the Organization Name field, otherwise type `${query.ownerLastName}` into the Last Name field
[stagehand][act] if `${query.isBusinessName}` is `false`, type `${query.ownerFirstName}` into the First Name field
[stagehand][act] type `${query.lot}` into Lot field
[stagehand][act] type `${query.county}` into Counties field then select it from the dropdown list
[page][press] Enter
[stagehand][act] Click the `Search` button at the bottom of the Advanced Search form
[stagehand][observe] find search results
[stagehand][act] look at the search results table, sort the rows by the Recorded Date to find the most recent entry, then Click the PDF download button in that row
[stagehand][switchtonewpage]
[stagehand][clickdownload] ./downloads/${query.propertyId}/deed.pdf
[page][waitfor] 5000
[page][goto] https://iowalandrecords.org/search/logout

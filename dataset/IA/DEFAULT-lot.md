[page][goto] https://iowalandrecords.org/cas/login
[stagehand][act] type `${process.env.CREDENTIALS_IA_HAMILTON_USERNAME}` into the username field
[stagehand][act] type `${process.env.CREDENTIALS_IA_HAMILTON_PASSWORD}` into the password field
[stagehand][act] click the login button
[stagehand][observe] find Advanced Search link under Start a New Search
[page][goto] https://iowalandrecords.org/search/guided/advanced?documentType=5&documentType=7&documentType=16&documentType=26&dateRange=NONE
[stagehand][observe] find the Advanced Search form
[if query.isBusinessName==='true']
[stagehand][act] type `${query.ownerLastName}` into the Organization Name field
[else]
[stagehand][act] type `${query.ownerLastName}` into the Last Name field
[stagehand][act] type `${query.ownerFirstName}` into the First Name field
[endif]
[stagehand][act] type `${query.lot}` into Lot field
[stagehand][act] type `${query.county}` into Counties field then select it from the dropdown list
[page][waitfor] 3000
[page][press] Enter
[stagehand][act] Click the `Search` button at the bottom of the Advanced Search form
[stagehand][observe] find search results
[stagehand][act] click the PDF icon on the right side of the row with the most recent Recorded Date in the search results
[stagehand][switchtonewpage]
[stagehand][clickdownload] ./downloads/${query.propertyId}/deed.pdf
[page][waitfor] 5000
[page][goto] https://iowalandrecords.org/search/logout

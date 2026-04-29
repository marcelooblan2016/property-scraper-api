[page][goto] https://www.myfloridacounty.com/orisearch/15
[if query.isBusinessName==='true']
[stagehand][act] type `${query.ownerLastName}` into the input field under the column header labeled `Party Name`
[else]
[stagehand][act] type `${query.ownerLastName} ${query.ownerFirstName}*` into the input field under the column header labeled `Party Name`
[endif]
[stagehand][act] scroll down to find the Book / Page Number fields, then type `${query.book}` into the Book field
[stagehand][act] type `${query.page}` into the Page field next to the Book field
[stagehand][handoff] Please click Search & solve the CAPTCHA, then click Resume when the search page loads.
[page][waitfor] 2000
[stagehand][act] click the `View Image` button in the first result row
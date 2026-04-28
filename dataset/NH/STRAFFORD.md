[page][goto] https://ava.fidlar.com/NHStrafford/AvaWeb/#/search
[if query.isBusinessName==='true']
[stagehand][act] click the `Business:` radio button
[stagehand][act] type `${query.ownerLastName}` into the input labeled `Last Name / Business Name` field
[else]
[stagehand][act] type `${query.ownerLastName}` into the input labeled `Last Name / Business Name` field
[stagehand][act] type `${query.ownerFirstName}` into the input labeled `First Name`
[endif]
[stagehand][act] type `${query.book}` into the input labeled `Book` field
[stagehand][act] type `${query.page}` into the input labeled `Page` field
[stagehand][act] click Search
[page][waitfor] 2000
[stagehand][act] click `EXPAND ALL` button
[stagehand][act] click the document number link next to the document icon in the first result row
[page][waitfor] 1000
[stagehand][observe] document has loaded
[stagehand][act] click the print icon
[page][waitfor] 1000
[stagehand][act] click OK button in the modal popup
[stagehand][handoff] enter credit card
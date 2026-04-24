[page][goto] https://registerofdeeds.buncombecounty.org/External/LandRecords/protected/v4/SrchBookPage.aspx
[stagehand][act] click Advanced Name tab
[if query.isBusinessName==='true']
[stagehand][act] type `${query.ownerLastName}` into the Firm / Surname field
[else]
[stagehand][act] type `${query.ownerLastName}` into the Firm / Surname field
[stagehand][act] type `${query.ownerFirstName}` into the Given Name field
[endif]
[stagehand][act] click `Search (All Matches)` button
[stagehand][act] in the search results table, find the row where Date Filed is `${query.lastRecorded}` and Type is `DEED`, then click the document/image icon in the Images column of that row
[stagehand][observe] find `Save Document as PDF`
[stagehand][waitfordownload]
[stagehand][act] click `Save Document as PDF`
[stagehand][triggerdownload] ./downloads/${query.propertyId}/deed.pdf

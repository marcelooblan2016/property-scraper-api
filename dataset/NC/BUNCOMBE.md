[page][goto] https://registerofdeeds.buncombecounty.org/External/LandRecords/protected/v4/SrchBookPage.aspx
[stagehand][act] click Book/Page tab
[stagehand][observe] find Book / Page Search
[stagehand][act] fill `Book` input field `${query.book}`
[stagehand][act] fill `Page` input field `${query.page}`
[stagehand][act] click `Search` button
[stagehand][observe] the search results appear
[stagehand][observe] find the clickable icon in the Images column of the first row
[page][clickselector] input[type="image"][id*="ibImage"]
[stagehand][observe] find `Save Document as PDF`
[stagehand][waitfordownload]
[stagehand][act] click `Save Document as PDF`
[stagehand][triggerdownload] ./downloads/${query.propertyId}/deed.pdf

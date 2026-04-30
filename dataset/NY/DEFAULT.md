[page][goto] https://a836-acris.nyc.gov/DS/DocumentSearch/PartyName
[if query.isBusinessName==='true']
[stagehand][act] click the `Business:` radio button
[stagehand][act] type `${query.ownerLastName}` into the BUSINESS NAME field
[else]
[stagehand][act] type `${query.ownerLastName}` into the input field under the column header labeled `LAST`
[stagehand][act] type `${query.ownerFirstName}` into the input field under the column header labeled `FIRST`
[endif]
[stagehand][act] select option that contains `${query.county}` in Select Borough/County dropdown
[stagehand][act] select `DEEDS AND OTHER CONVEYANCES` in Select Document Class dropdown
[stagehand][act] click Search
[page][waitfor] 1000
[stagehand][act] look at the search results table, sort the rows by the Recorded/Filed column to find the most recent entry where Block is `${query.block}` and Lot is `${query.lot}`, then click the IMG button in that row
[stagehand][waitfornavigation] 3000
[stagehand][observe] the document image has loaded
[page][waitfor] 3000
[stagehand][waitfordownload]
[page][waitfor] 3000
[page][clickselector] img[src*="save.png"][title="Save"]
[stagehand][observe] wait for save modal to appear
[page][waitfor] 5000
[stagehand][act] click the OK button in the Save dialog
[stagehand][triggerdownload] ./downloads/${query.propertyId}/deed.pdf

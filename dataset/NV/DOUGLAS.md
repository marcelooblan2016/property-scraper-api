[page][goto] https://recorder-search.douglasnv.us/Recording/RecordingSearch?mode=Advanced
[if query.isBusinessName==='true']
[page][do] await page.type('#Criteria_Filter_LastName', "${query.ownerLastName}")
[else]
[page][do] await page.type('#Criteria_Filter_LastName', "${query.ownerLastName}")
[page][do] await page.type('#Criteria_Filter_FirstName', "${query.ownerFirstName}")
[endif]
[if query.book!=='' && query.page!=='']
[page][do] await page.type("#Criteria_Filter_HistoricNumber", "${query.book}-${query.page}")
[endif]
[if query.apn!=='']
[page][do] await page.type("#Criteria_Filter_PropertyId", "${query.apn}")
[endif]
[page][do] await page.click('#adv-search-btn')
[stagehand][handoff] TODO...
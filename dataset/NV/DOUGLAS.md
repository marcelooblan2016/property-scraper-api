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
[page][evaluate] (function(){ var sel = document.getElementById('Filter_DocumentSubtype'); sel.value = 'DEED'; sel.dispatchEvent(new Event('change', {bubbles:true})); return true; })()
[page][evaluate] (function(){ var sel = document.getElementById('sort-by-options-search'); sel.value = 'RecordingDate'; sel.dispatchEvent(new Event('change', {bubbles:true})); return true; })()
[page][do] await page.click('#adv-search-btn')
[page][waitfor] 3000
[page][evaluate] (function(){ var el = document.querySelector('.search-result:first-child .recording-link'); if(!el) throw new Error('No recording link found'); el.click(); return true; })()
[page][waitfor] 2000
[page][evaluate] (function(){ var el = document.querySelector('.helion-image a'); if(!el) throw new Error('PDF link not found'); el.click(); return true; })()
[page][waitfor] 1000
[page][downloadnewtab] ./downloads/${query.propertyId}/deed.pdf
[page][goto] https://www.myfloridacounty.com/official_records/index.html?thisPage=MyFloridaCounty.ORI.Order.state.Start
[page][waitfor] 4000
[page][evaluate] (function(){ var sel = document.getElementById('countyDropdown'); var opt = Array.from(sel.options).find(function(o){ return o.text.trim().toUpperCase() === '${query.county}'.toUpperCase(); }); if(!opt) throw new Error('County not found: ${query.county}'); sel.value = opt.value; sel.dispatchEvent(new Event('change', {bubbles:true})); return true; })()
[page][evaluate] (function(){ var btn = document.querySelector('button[onclick*="redirectToCounty"]'); if(!btn) throw new Error('Go button not found'); btn.click(); return true; })()
[page][waitfor] 4000
[if query.isBusinessName==='true']
[page][do] await page.type('#name', "${query.ownerLastName}")
[else]
[page][do] await page.type('#name', "${query.ownerLastName} ${query.ownerFirstName}*")
[endif]
[page][do] await page.type('#book', "${query.book}")
[page][do] await page.type('#page_number', "${query.page}")
[page][waitfor] 2000
[page][do] await page.click('input[value="Search"]')
[page][waitfor] 2000
[stagehand][handoff] Please click Search & solve the CAPTCHA, then click Resume when the search page loads.
[page][evaluate] (function(){ var rows = document.querySelectorAll('tr'); var row = Array.from(rows).find(function(r){ return r.textContent.includes('${query.book}/${query.page}'); }); if(!row) throw new Error('Row not found'); var link = row.querySelector('a.a_btn'); if(!link) throw new Error('View Image not found'); link.click(); return true; })()
[page][waitfor] 2000
[page][downloadnewtab] ./downloads/${query.propertyId}/deed.pdf
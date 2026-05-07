[page][goto] https://ava.fidlar.com/IABlackHawk/AvaWeb/#/search
[page][waitfor] 3000
[if query.isBusinessName==='true']
[page][do] await page.type('input[formcontrolname="LastBusinessName"]', "${query.ownerLastName}")
[else]
[page][do] await page.type('input[formcontrolname="LastBusinessName"]', "${query.ownerLastName}")
[page][do] await page.type('input[formcontrolname="FirstName"]', "${query.ownerFirstName}")
[endif]
[page][waitfor] 3000
[page][do] await page.type('input[formcontrolname="Book"]', "${query.book}")
[page][do] await page.type('input[formcontrolname="Page"]', "${query.page}")
[page][waitfor] 3000
[page][do] await page.click('button[form="searchForm"]')
[page][waitfor] 3000
[page][waitforselector] button.yellow
[page][evaluate] (function(){ var btn = Array.from(document.querySelectorAll('button.yellow')).find(function(b){ return b.textContent.trim().includes('Expand All'); }); if(!btn) throw new Error('Expand All button not found'); btn.click(); return true; })()
[page][waitfor] 1000
[page][clickselector] .resultRow:first-child .resultRowDetail button
[page][waitfor] 5000
[page][evaluate] (function(){ var el = document.querySelector('button[title="Print"]'); if(!el) throw new Error('Print button not found'); el.click(); return true; })()
[page][waitfor] 3000
[page][evaluate] (function(){ var el = Array.from(document.querySelectorAll('button')).find(function(b){ return b.textContent.trim() === 'OK'; }); if(!el) throw new Error('OK button not found'); el.click(); return true; })()
[stagehand][handoff] Enter CC info to download PDF
[page][goto] https://ava.fidlar.com/NHStrafford/AvaWeb/#/search
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

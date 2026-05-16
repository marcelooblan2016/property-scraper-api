[page][goto] https://www.myfloridacounty.com/official_records/index.html?thisPage=MyFloridaCounty.ORI.Order.state.Start
[page][waitfor] 4000 [text="Waiting for the page to load"]
[page][evaluate] (function(){ var sel = document.getElementById('countyDropdown'); var opt = Array.from(sel.options).find(function(o){ return o.text.trim().toUpperCase() === '${query.county}'.toUpperCase(); }); if(!opt) throw new Error('County not found: ${query.county}'); sel.value = opt.value; sel.dispatchEvent(new Event('change', {bubbles:true})); return true; })() [text="Select County"]
[page][evaluate] (function(){ var btn = document.querySelector('button[onclick*="redirectToCounty"]'); if(!btn) throw new Error('Go button not found'); btn.click(); return true; })() [text="Redirect to the selected County website"]
[page][waitforurl] /orisearch/ [text="Waiting for county search page"]
[if query.documentType==='deed']
    [page][waitforselector] #documentTypeID
    [page][evaluate] (function(){ var sel = document.getElementById('documentTypeID'); var opt = Array.from(sel.options).find(function(o){ return o.text.trim().toUpperCase() === '${query.documentType}'.toUpperCase(); }); if(!opt) throw new Error('Document type not found: ${query.documentType}'); Array.from(sel.options).forEach(function(o){ o.selected = false; }); opt.selected = true; sel.dispatchEvent(new Event('change', {bubbles:true})); return true; })() [text="Select document type: ${query.documentType}"]
[endif]
[if query.formType==='name']
    [page][waitforselector] #name
    [if query.isBusinessName==='true']
    [page][do] await page.type('#name', "${query.ownerLastName}") [text="Type the business name in the Owner Name field ${query.ownerLastName}"]
    [else]
    [page][do] await page.type('#name', "${query.ownerLastName} ${query.ownerFirstName}*") [text="Type the owner name in the Owner Name field ${query.ownerLastName} ${query.ownerFirstName}*"]
    [endif]
    [page][waitfor] 2000
    [page][waitforselector] input[value="Search"]
    [page][do] await page.click('input[value="Search"]') [text="Click the Search button"]
    [page][captcha-detection]
    [page][waitfor] 1000
    [page][evaluate] (function(){ var sel = document.getElementById('ori_pagesize'); var opt = Array.from(sel.options).find(function(o){ return o.value === '100'; }); if(!opt) throw new Error('Page size 100 not found'); opt.selected = true; sel.dispatchEvent(new Event('change', {bubbles:true})); return true; })() [text="Set page size to 100"]
    [page][waitfor] 1000
    [page][waitforselector] #ori_results
    [page][smart-download] ./downloads/${query.propertyId}/deed.pdf 300000 [text="Smart download FL"]

[elseif query.formType==='book_page']
    [page][waitfor] 1000
    [page][waitforselector] #book
    [page][do] await page.type('#book', "${query.book}") [text="Type the book number in the Book field ${query.book}"]
    [page][waitforselector] #page_number
    [page][do] await page.type('#page_number', "${query.page}") [text="Type the page number in the Page field ${query.page}"]
    [page][waitfor] 2000
    [page][waitforselector] input[value="Search"]
    [page][do] await page.click('input[value="Search"]') [text="Click the Search button"]
    [page][captcha-detection]
    [page][waitfor] 1000
    [page][evaluate] (function(){ var rows = document.querySelectorAll('tr'); var row = Array.from(rows).find(function(r){ return r.textContent.includes('${query.book}/${query.page}'); }); if(!row) throw new Error('Row not found'); var link = row.querySelector('a.a_btn'); if(!link) throw new Error('View Image not found'); window.__samHref = link.getAttribute('href'); return true; })() [text="Find View Image link for ${query.book}/${query.page}"]
    [page][download-href] __samhref -> ./downloads/${query.propertyId}/deed.pdf [text="Download deed PDF for ${query.book}/${query.page}"]
[endif]

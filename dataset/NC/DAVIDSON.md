[page][goto] https://www.davidsondeeds.com/davidsonNameSearch.php
[stagehand][observe] `LEGAL DISCLAIMER`
[stagehand][act] click `Accept` button
[stagehand][act] fill `Book` input field `${query.book}`
[stagehand][act] fill `Page` input field `${query.page}`
[stagehand][act] on `Book-Page (OR) File # Search`, click the `Search` button
[stagehand][observe] Detail Screen
[stagehand][act] on Perm Indexed, click `PDF` link
[stagehand][switchtonewpage]
[stagehand][clickdownload] ./downloads/${query.propertyId}/deed.pdf

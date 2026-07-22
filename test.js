
const puppeteer = require('puppeteer');
(async () => {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  await page.setContent(\<script>
      const els = { msg: 'hello' };
      var myVar = { msg: 'world' };
    </script>
    <button id='btn1' onclick='document.title = typeof els'>Btn1</button>
    <button id='btn2' onclick='document.title = typeof myVar'>Btn2</button>\);
  await page.click('#btn1');
  console.log('els:', await page.title());
  await page.click('#btn2');
  console.log('myVar:', await page.title());
  await browser.close();
})();


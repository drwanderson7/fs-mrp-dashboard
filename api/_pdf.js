// Turns the Line Report page into a PDF with a headless Chromium.
// On Vercel the browser is downloaded on first use (it is too big to ship with the code).
const CHROMIUM_PACK = 'https://github.com/Sparticuz/chromium/releases/download/v153.0.0/chromium-v153.0.0-pack.x64.tar';

export async function htmlToPdf(html) {
  const puppeteer = (await import('puppeteer-core')).default;
  let launch;
  if (process.env.LOCAL_CHROME) {   // local testing
    launch = { executablePath: process.env.LOCAL_CHROME, args: ['--no-sandbox'], headless: true };
  } else {
    const chromium = (await import('@sparticuz/chromium-min')).default;
    launch = { executablePath: await chromium.executablePath(CHROMIUM_PACK), args: chromium.args, headless: true };
  }
  const browser = await puppeteer.launch(launch);
  try {
    const page = await browser.newPage();
    // the report's own print button/script is not needed here
    await page.setContent(html.replace(/<script>[\s\S]*?<\/script>/g, ''), { waitUntil: 'load', timeout: 30000 });
    await page.emulateMediaType('print');
    const pdf = await page.pdf({ format: 'Letter', landscape: true, printBackground: true, preferCSSPageSize: true });
    return Buffer.from(pdf);
  } finally { await browser.close().catch(() => {}); }
}

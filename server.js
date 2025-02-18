require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const xml2js = require("xml2js");
const cron = require("node-cron");
const nodemailer = require("nodemailer");

const app = express();
const PORT = process.env.PORT || 3000;

// Email Configuration
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const RECIPIENT_EMAILS = process.env.RECIPIENT_EMAILS
  ? process.env.RECIPIENT_EMAILS.split(",")
  : [];

const SEC_URLS = {
  "13F-HR":
    "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001045810&type=13F-HR&dateb=&owner=exclude&count=2",
  "SC 13D":
    "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001045810&type=SC%2013D&dateb=&owner=exclude&count=2",
  "SC 13G":
    "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001045810&type=SC%2013G&dateb=&owner=exclude&count=2",
};

// Store last 2 filings for comparison
let filingsData = {};

/**
 * Fetch SEC Data with Headers & Retry Logic to Avoid 403 Errors
 */
async function fetchWithRetry(url, retries = 3, delay = 3000) {
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://www.sec.gov/",
  };

  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get(url, { headers });
      return response.data;
    } catch (error) {
      if (error.response && error.response.status === 403) {
        console.warn(
          `[SEC Blocked] Retrying (${i + 1}/${retries}) in ${delay / 1000}s...`
        );
        await new Promise((res) => setTimeout(res, delay));
      } else {
        throw error;
      }
    }
  }
  throw new Error(`[Error] Failed to fetch SEC data after ${retries} attempts`);
}

/**
 * Scrape SEC Filings for NVIDIA
 */
async function scrapeSecFilings() {
  let newFilings = {};

  for (const [filingType, url] of Object.entries(SEC_URLS)) {
    console.log(`[Scraper] Checking latest ${filingType} filings...`);
    try {
      const data = await fetchWithRetry(url);
      const $ = cheerio.load(data);
      let filings = [];

      $("tr").each((index, element) => {
        const linkElement = $(element).find("a[href*='Archives/edgar/data']");
        const filingDate = $(element).find("td:nth-child(4)").text().trim();

        if (linkElement.length > 0) {
          const filingLink = "https://www.sec.gov" + linkElement.attr("href");
          filings.push({ filingDate, filingLink });
        }
      });

      if (filings.length >= 2) {
        newFilings[filingType] = [filings[0], filings[1]];
      }
    } catch (error) {
      console.error(`[Scraper] Error fetching SEC filings: ${error.message}`);
    }
  }

  if (Object.keys(newFilings).length > 0) {
    console.log(`[Scraper] Processing changes...`);
    await compareFilings(newFilings);
  } else {
    console.log("[Scraper] No new filings detected.");
  }
}

/**
 * Compare Last Two Filings for Changes
 */
async function compareFilings(newFilings) {
  let changes = [];

  for (const [filingType, filings] of Object.entries(newFilings)) {
    console.log(`[Comparison] Checking ${filingType}...`);
    const oldFiling = filings[1];
    const newFiling = filings[0];

    let oldInvestments = await extractInvestmentData(oldFiling);
    let newInvestments = await extractInvestmentData(newFiling);

    let investmentChanges = detectChanges(oldInvestments, newInvestments);
    if (investmentChanges.length > 0) {
      changes.push(...investmentChanges);
    }
  }

  if (changes.length > 0) {
    console.log(`[Notifier] Sending email summary...`);
    await sendEmailNotification(changes);
  }
}

/**
 * Extract Investment Data from SEC Filings
 */
async function extractInvestmentData(filing) {
  try {
    const data = await fetchWithRetry(filing.filingLink);
    const $ = cheerio.load(data);

    let xmlFileLink = $("a[href*='information_table.xml']").attr("href");
    if (xmlFileLink) {
      return await extractInvestmentsFromXML(
        "https://www.sec.gov" + xmlFileLink
      );
    }

    return extractInvestmentsFromHTML($);
  } catch (error) {
    console.error(
      `[Parser] Error fetching or parsing filing: ${error.message}`
    );
    return [];
  }
}

/**
 * Fix XML Parsing Issue & Extract Investments from XML
 */
async function extractInvestmentsFromXML(xmlFileLink) {
  try {
    const data = await fetchWithRetry(xmlFileLink);
    const parser = new xml2js.Parser({ strict: false }); // Allow invalid XML

    return new Promise((resolve) => {
      parser.parseString(data, (err, result) => {
        if (err) {
          console.error("[Parser] Error parsing XML:", err);
          resolve([]);
        }

        const holdings = result["informationTable"]["infoTable"];
        if (!holdings || !Array.isArray(holdings)) {
          console.log("[Parser] No valid holdings found in XML.");
          resolve([]);
        }

        resolve(
          holdings.map((entry) => ({
            company: entry["nameOfIssuer"],
            shares: entry["shrsOrPrnAmt"]["sshPrnamt"],
            value: entry["value"],
          }))
        );
      });
    });
  } catch (error) {
    console.error("[Parser] Failed to fetch or parse XML:", error.message);
    return [];
  }
}

/**
 * Detect Investment Changes
 */
function detectChanges(oldInvestments, newInvestments) {
  let changes = [];

  newInvestments.forEach((newInv) => {
    const oldInv = oldInvestments.find((inv) => inv.company === newInv.company);

    if (!oldInv) {
      changes.push(
        `🟢 New Investment in **${newInv.company}** - ${newInv.shares} shares worth $${newInv.value}`
      );
    } else if (newInv.shares > oldInv.shares) {
      changes.push(
        `🔺 Increased stake in **${newInv.company}** - Now ${newInv.shares} shares (previously ${oldInv.shares})`
      );
    } else if (newInv.shares < oldInv.shares) {
      changes.push(
        `🔻 Reduced stake in **${newInv.company}** - Now ${newInv.shares} shares (previously ${oldInv.shares})`
      );
    }
  });

  return changes;
}

/**
 * Manual Trigger Endpoint
 */
app.get("/run-scraper", async (req, res) => {
  console.log("[Manual Trigger] Running SEC filings check...");
  await scrapeSecFilings();
  res.json({ status: "success", message: "Investment scan completed." });
});

/**
 * Health Check Endpoint
 */
app.get("/health", (req, res) => {
  res.json({ status: "running", timestamp: new Date().toISOString() });
});

// **Run Scraper Every Hour**
cron.schedule("0 * * * *", () => scrapeSecFilings());

// **Start Server**
app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  scrapeSecFilings();
});

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
 * Extract Investment Data from XML Filings
 */
async function extractInvestmentsFromXML(xmlFileLink) {
  try {
    const data = await fetchWithRetry(xmlFileLink);
    const parser = new xml2js.Parser({ strict: false, explicitArray: false });

    return new Promise((resolve) => {
      parser.parseString(data, (err, result) => {
        if (err) {
          console.error("[Parser] Error parsing XML:", err);
          resolve([]);
          return;
        }

        console.log("[Parser] Successfully parsed XML.");

        // Check if `informationTable` exists and has `infoTable`
        if (
          !result ||
          !result.informationTable ||
          !result.informationTable.infoTable
        ) {
          console.warn("[Parser] No valid investment data found in XML.");
          console.log(
            "[Parser] XML Structure:",
            JSON.stringify(result, null, 2)
          );
          resolve([]);
          return;
        }

        const holdings = Array.isArray(result.informationTable.infoTable)
          ? result.informationTable.infoTable
          : [result.informationTable.infoTable];

        resolve(
          holdings.map((entry) => ({
            company: entry.nameOfIssuer || "Unknown",
            shares: entry.shrsOrPrnAmt?.sshPrnamt || "0",
            value: entry.value || "0",
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
 * Extract Investments from HTML Filings (Fallback if XML is missing)
 */
function extractInvestmentsFromHTML($) {
  let investments = [];

  $("table tbody tr").each((index, element) => {
    const company = $(element).find("td:nth-child(1)").text().trim();
    const shares = $(element).find("td:nth-child(2)").text().trim();
    const value = $(element).find("td:nth-child(3)").text().trim();

    if (company && shares && value && company.length > 2) {
      investments.push({ company, shares, value });
    }
  });

  return investments;
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
 * Health Check Endpoint
 */
app.get("/health", (req, res) => {
  res.json({ status: "running", timestamp: new Date().toISOString() });
});

/**
 * Manual Trigger Endpoint
 */
app.get("/run-scraper", async (req, res) => {
  console.log("[Manual Trigger] Running SEC filings check...");
  await scrapeSecFilings();
  res.json({ status: "success", message: "Investment scan completed." });
});

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

// **Run Scraper Every Hour**
cron.schedule("0 * * * *", () => scrapeSecFilings());

// **Start Server**
app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  scrapeSecFilings();
});

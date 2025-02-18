require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
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

// Read multiple recipients from .env
const RECIPIENT_EMAILS = process.env.RECIPIENT_EMAILS
  ? process.env.RECIPIENT_EMAILS.split(",")
  : [];

// SEC Filings URLs for NVIDIA (Fetching Only the Latest Filing)
const SEC_URLS = {
  "13F-HR":
    "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001045810&type=13F-HR&dateb=&owner=exclude&count=1",
  "SC 13D":
    "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001045810&type=SC%2013D&dateb=&owner=exclude&count=1",
  "SC 13G":
    "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001045810&type=SC%2013G&dateb=&owner=exclude&count=1",
};

// Store the most recent filing data in memory (No file storage)
let previousFilings = {};

/**
 * Fetch Public IP Address of the Server
 */
async function getPublicIP() {
  try {
    const response = await axios.get("https://api64.ipify.org?format=json");
    return response.data.ip;
  } catch (error) {
    console.error("[Error] Unable to fetch Public IP:", error.message);
    return "UNKNOWN_IP";
  }
}

/**
 * Scrape Latest SEC Filings for NVIDIA
 */
async function scrapeSecFilings() {
  let newFilings = [];

  for (const [filingType, url] of Object.entries(SEC_URLS)) {
    console.log(`[Scraper] Checking latest ${filingType} filing...`);
    const { data } = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const $ = cheerio.load(data);

    let foundNewFiling = false;
    $("tr").each((index, element) => {
      const linkElement = $(element).find("a[href*='Archives/edgar/data']");
      const filingDate = $(element).find("td:nth-child(4)").text().trim();

      if (linkElement.length > 0) {
        const filingLink = "https://www.sec.gov" + linkElement.attr("href");

        if (
          !previousFilings[filingType] ||
          previousFilings[filingType].filingDate !== filingDate
        ) {
          newFilings.push({ filingType, filingDate, filingLink });
          previousFilings[filingType] = { filingDate, filingLink }; // Update memory storage
          foundNewFiling = true;
        }
      }
    });

    if (!foundNewFiling) {
      console.log(`[Scraper] No new ${filingType} filing found.`);
    }
  }

  if (newFilings.length > 0) {
    console.log(
      `[Scraper] Found ${newFilings.length} new filing(s). Processing...`
    );
    await processFilings(newFilings);
  } else {
    console.log("[Scraper] No new filings detected.");
  }
}

/**
 * Process Latest Filings to Extract Investment Data
 */
async function processFilings(filings) {
  let investmentChanges = [];

  for (const filing of filings) {
    console.log(
      `[Processing] Extracting investments from ${filing.filingLink}...`
    );

    const { data } = await axios.get(filing.filingLink, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const $ = cheerio.load(data);

    // Extract investment details from the filing
    let investments = [];
    $("table tbody tr").each((index, element) => {
      const company = $(element).find("td:nth-child(1)").text().trim();
      const shares = $(element).find("td:nth-child(2)").text().trim();
      const value = $(element).find("td:nth-child(3)").text().trim();

      // **Filter out metadata (XBRL, Submission Text, etc.)**
      if (
        company &&
        shares &&
        value &&
        !company.includes("SUBMISSION TEXT FILE")
      ) {
        let change = determineInvestmentChange(
          company,
          shares,
          filing.filingType
        );
        investmentChanges.push({ company, shares, value, change, filing });
      }
    });
  }

  if (investmentChanges.length > 0) {
    console.log(`[Notifier] Sending email summary...`);
    await sendEmailNotification(investmentChanges);
  }
}

/**
 * Detects Investment Changes (New, Increased, Reduced, Exited)
 */
function determineInvestmentChange(company, newShares, filingType) {
  // Since history is not stored, only compare with the last filing
  if (filingType === "SC 13D" || filingType === "SC 13G") {
    if (newShares === "0") return "❌ Exited Investment (Ownership Below 5%)";
  }
  return "🟢 New Investment";
}

/**
 * Send Cleaned Email Notification (Only Shows the Most Recent Filings)
 */
async function sendEmailNotification(filings) {
  let publicIP = await getPublicIP();
  let triggerURL = `http://${publicIP}:${PORT}/run-scraper`;

  let filingDetails = filings
    .map(
      (filing) =>
        `<li>📜 **${filing.change}** - ${filing.company}, Shares: ${filing.shares}, Value: ${filing.value}, Date: ${filing.filing.filingDate} | <a href="${filing.filing.filingLink}">View Filing</a></li>`
    )
    .join("");

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: RECIPIENT_EMAILS,
    subject: `📢 NVIDIA Investment Alert: Latest Filings`,
    html: `<h3>🚀 NVIDIA Investment Activity Detected</h3><ul>${filingDetails}</ul><p>📍 <strong>Public IP:</strong> ${publicIP}</p><p>🔗 <a href="${triggerURL}">Trigger Scraper</a></p>`,
  };

  await transporter.sendMail(mailOptions);
  console.log("[Notifier] Email sent successfully!");
}

// **Run Scraper Every Hour**
cron.schedule("0 * * * *", () => scrapeSecFilings());

// **Manual Trigger Endpoint**
app.get("/run-scraper", async (req, res) => {
  await scrapeSecFilings();
  res.json({ status: "success", message: "Investment scan completed." });
});

// **Start Server**
app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  scrapeSecFilings();
});

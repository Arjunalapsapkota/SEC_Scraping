require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const xml2js = require("xml2js"); // For parsing XML investment tables
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

// SEC Filings URLs for NVIDIA (Fetching Only the 2 Most Recent Filings)
const SEC_URLS = {
  "13F-HR":
    "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001045810&type=13F-HR&dateb=&owner=exclude&count=2",
  "SC 13D":
    "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001045810&type=SC%2013D&dateb=&owner=exclude&count=2",
  "SC 13G":
    "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001045810&type=SC%2013G&dateb=&owner=exclude&count=2",
};

// Store only the last 2 filings for each type (Memory Storage)
let filingsData = {};

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
  let newFilings = {};

  for (const [filingType, url] of Object.entries(SEC_URLS)) {
    console.log(`[Scraper] Checking latest ${filingType} filings...`);
    const { data } = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
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

    // Store only the last 2 filings
    if (filings.length >= 2) {
      newFilings[filingType] = [filings[0], filings[1]]; // Latest two
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
 * Compare the Last Two Filings to Detect Changes
 */
async function compareFilings(newFilings) {
  let changes = [];

  for (const [filingType, filings] of Object.entries(newFilings)) {
    console.log(
      `[Comparison] Checking differences in ${filingType} filings...`
    );

    const oldFiling = filings[1]; // Previous filing
    const newFiling = filings[0]; // Latest filing

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
 * Send Email Notification
 */
async function sendEmailNotification(changes) {
  let publicIP = await getPublicIP();
  let triggerURL = `http://${publicIP}:${PORT}/run-scraper`;

  let emailBody = `<h3>🚀 NVIDIA Investment Changes</h3><ul>`;
  changes.forEach((change) => {
    emailBody += `<li>${change}</li>`;
  });
  emailBody += `</ul><p>📍 <strong>Server Public IP:</strong> ${publicIP}</p>`;
  emailBody += `<p>🔗 <a href="${triggerURL}">Trigger Scraper</a></p>`;

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: RECIPIENT_EMAILS,
    subject: `📢 NVIDIA Investment Alert`,
    html: emailBody,
  };

  await transporter.sendMail(mailOptions);
  console.log("[Notifier] Email sent successfully!");
}

/**
 * Health Check Endpoint
 */
app.get("/health", (req, res) => {
  res.json({ status: "running", timestamp: new Date().toISOString() });
});

/**
 * Manual Scraper Trigger
 */
app.get("/run-scraper", async (req, res) => {
  console.log("[Manual Trigger] Running SEC filings check...");
  await scrapeSecFilings();
  res.json({ status: "success", message: "Investment scan completed." });
});

// **Run Scraper Every Hour**
cron.schedule("0 * * * *", () => scrapeSecFilings());

// **Start Server**
app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  scrapeSecFilings();
});

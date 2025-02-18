require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cron = require("node-cron");
const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");

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

// SEC Filings URLs for NVIDIA
const SEC_URLS = {
  "13F-HR":
    "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001045810&type=13F-HR&dateb=&owner=exclude&count=40",
  "8-K":
    "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001045810&type=8-K&dateb=&owner=exclude&count=40",
  "SC 13D":
    "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001045810&type=SC%2013D&dateb=&owner=exclude&count=40",
  "SC 13G":
    "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001045810&type=SC%2013G&dateb=&owner=exclude&count=40",
};

// CSV File to Store Past Filings
const CSV_FILE = "nvidia_investments.csv";

// Ensure CSV file exists
if (!fs.existsSync(CSV_FILE)) {
  fs.writeFileSync(CSV_FILE, "Date,Type,Company,Shares,Value,Change,Link\n");
}

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
 * Scrape Multiple SEC Filings for NVIDIA
 */
async function scrapeSecFilings() {
  let allNewFilings = [];

  for (const [filingType, url] of Object.entries(SEC_URLS)) {
    console.log(`[Scraper] Checking ${filingType} filings...`);
    const { data } = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const $ = cheerio.load(data);

    $("tr").each((index, element) => {
      const linkElement = $(element).find("a[href*='Archives/edgar/data']");
      const filingDate = $(element).find("td:nth-child(4)").text().trim();

      if (linkElement.length > 0) {
        const filingLink = "https://www.sec.gov" + linkElement.attr("href");

        if (!isFilingStored(filingDate, filingType, filingLink)) {
          allNewFilings.push({ filingType, filingDate, filingLink });
          storeFiling(filingDate, filingType, filingLink);
        }
      }
    });
  }

  if (allNewFilings.length > 0) {
    console.log(
      `[Scraper] Found ${allNewFilings.length} new filing(s). Processing...`
    );
    await processFilings(allNewFilings);
  } else {
    console.log("[Scraper] No new investment filings found.");
  }
}

/**
 * Store the filing details in a CSV file
 */
function storeFiling(date, type, link) {
  fs.appendFileSync(CSV_FILE, `${date},${type},N/A,N/A,N/A,N/A,${link}\n`);
}

/**
 * Check if the filing is already stored
 */
function isFilingStored(date, type, link) {
  const fileData = fs.readFileSync(CSV_FILE, "utf8");
  return fileData.includes(`${date},${type},${link}`);
}

/**
 * Detects Investment Changes (New, Increased, Reduced, Exited)
 */
function determineInvestmentChange(company, newShares, filingType) {
  const fileData = fs.readFileSync(CSV_FILE, "utf8");
  const rows = fileData.split("\n").map((row) => row.split(","));

  for (let row of rows) {
    if (row.length > 2 && row[2] === company) {
      const oldShares = parseInt(row[3].replace(/,/g, ""), 10);
      const newSharesInt = parseInt(newShares.replace(/,/g, ""), 10);

      if (newSharesInt > oldShares) return "🔺 Increased Stake";
      if (newSharesInt < oldShares && newSharesInt > 0)
        return "🔻 Reduced Stake";
      if (newSharesInt === 0) return "❌ Exited Investment";
    }
  }

  if (
    (filingType === "SC 13D" || filingType === "SC 13G") &&
    newShares === "0"
  ) {
    return "❌ Exited Investment (Ownership Below 5%)";
  }

  return "🟢 New Investment";
}

/**
 * Process Filings to Extract Investment Data
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
    let investments = [];

    $("table tbody tr").each((index, element) => {
      const company = $(element).find("td:nth-child(1)").text().trim();
      const shares = $(element).find("td:nth-child(2)").text().trim();
      const value = $(element).find("td:nth-child(3)").text().trim();

      if (company && shares && value) {
        let change = determineInvestmentChange(
          company,
          shares,
          filing.filingType
        );
        if (change) {
          investmentChanges.push({ company, shares, value, change, filing });
        }
        investments.push({ company, shares, value });
      }
    });

    storeFiling(filing.filingDate, filing.filingType, filing.filingLink);
  }

  if (investmentChanges.length > 0) {
    console.log(`[Notifier] Sending email summary...`);
    await sendEmailNotification(investmentChanges);
  }
}

/**
 * Send Email Notification
 */
async function sendEmailNotification(filings) {
  let publicIP = await getPublicIP();
  let triggerURL = `http://${publicIP}:${PORT}/run-scraper`;

  let filingDetails = filings
    .map(
      (filing) =>
        `<li>📜 **${filing.change}** - ${filing.company}, Shares: ${filing.shares}, Value: ${filing.value} | <a href="${filing.filing.filingLink}">View Filing</a></li>`
    )
    .join("");

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: RECIPIENT_EMAILS,
    subject: `📢 NVIDIA Investment Filings Alert`,
    html: `<h3>🚀 NVIDIA Investment Activity Detected</h3><ul>${filingDetails}</ul><p>📍 <strong>Public IP:</strong> ${publicIP}</p><p>🔗 <a href="${triggerURL}">Trigger Scraper</a></p>`,
  };

  await transporter.sendMail(mailOptions);
  console.log("[Notifier] Email sent successfully!");
}

// **Start Server**
app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  scrapeSecFilings();
});

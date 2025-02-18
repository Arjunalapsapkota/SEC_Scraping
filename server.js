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
 * Send email notification summarizing investment changes
 */
async function sendEmailNotification(filings) {
  try {
    let publicIP = await getPublicIP();
    let triggerURL = `http://${publicIP}:${PORT}/run-scraper`;

    let filingDetails = filings
      .map(
        (filing) =>
          `<li>📜 **${filing.filingType}** - Date: ${filing.filingDate} | <a href="${filing.filingLink}">View Filing</a></li>`
      )
      .join("");

    const emailBody = `
            <h3>🚀 NVIDIA Investment Activity Detected</h3>
            <p>The following SEC filings were found:</p>
            <ul>${filingDetails}</ul>
            <br>
            <p>📍 <strong>Server Public IP:</strong> ${publicIP}</p>
            <p>🔗 <strong>Trigger the scraper manually:</strong> <a href="${triggerURL}">${triggerURL}</a></p>
        `;

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: RECIPIENT_EMAILS,
      subject: `📢 NVIDIA Investment Filings Alert`,
      html: emailBody,
    };

    await transporter.sendMail(mailOptions);
    console.log("[Notifier] Email sent successfully!");
  } catch (error) {
    console.error("[Notifier] Error sending email:", error.message);
  }
}

// **Run scraper every hour**
cron.schedule("0 * * * *", () => {
  scrapeSecFilings();
  console.log("[Cron] Hourly SEC filing check executed.");
});

// **Manual Trigger Endpoint**
app.get("/run-scraper", async (req, res) => {
  console.log("[Manual Trigger] Running SEC filings check...");
  await scrapeSecFilings();
  res.json({ status: "success", message: "Investment scan completed." });
});

// **Start Server**
app.listen(PORT, async () => {
  let publicIP = await getPublicIP();
  console.log(`[Server] Running on http://${publicIP}:${PORT}`);
  scrapeSecFilings();
});

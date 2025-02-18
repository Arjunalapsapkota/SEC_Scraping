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

// Email Configuration (Read from .env)
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const RECIPIENT_EMAIL = process.env.RECIPIENT_EMAIL;

// SEC Filings Page for NVIDIA
const SEC_URL =
  "https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001045810&type=&dateb=&owner=exclude&count=40";

// Filings categorized by frequency
const HIGH_PRIORITY_FILINGS = ["13F-HR", "8-K", "SC 13D", "SC 13G"];
const LONG_TERM_FILINGS = ["10-K", "10-Q"];

// CSV File for tracking
const CSV_FILE = path.join(__dirname, "nvidia_sec_filings.csv");

// Ensure CSV file exists
if (!fs.existsSync(CSV_FILE)) {
  fs.writeFileSync(CSV_FILE, "Date,Type,Company,Shares,Value,Change,Link\n");
}

/**
 * Scrape SEC for NVIDIA's filings
 */
async function scrapeSecFilings(filingsToTrack) {
  try {
    console.log(
      `[Scraper] Checking for NVIDIA ${filingsToTrack.join(", ")} filings...`
    );

    const { data } = await axios.get(SEC_URL, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    const $ = cheerio.load(data);
    let newFilings = [];

    $("tr").each((index, element) => {
      const linkElement = $(element).find("a[href*='Archives/edgar/data']");
      const filingType = $(element).find("td:nth-child(1)").text().trim();
      const filingDate = $(element).find("td:nth-child(4)").text().trim();

      if (linkElement.length > 0 && filingsToTrack.includes(filingType)) {
        const filingLink = "https://www.sec.gov" + linkElement.attr("href");

        if (!isFilingStored(filingDate, filingType, filingLink)) {
          storeFiling(filingDate, filingType, filingLink);
          newFilings.push({ filingType, filingDate, filingLink });
        }
      }
    });

    if (newFilings.length > 0) {
      console.log(
        `[Scraper] Found ${newFilings.length} new relevant filing(s). Sending email...`
      );
      await sendEmailNotification(newFilings);
    } else {
      console.log("[Scraper] No new relevant filings found.");
    }

    return newFilings;
  } catch (error) {
    console.error("[Scraper] Error fetching SEC filings:", error.message);
    return [];
  }
}

/**
 * Store the filing details in a CSV file
 */
function storeFiling(date, type, link) {
  const csvData = `${date},${type},N/A,N/A,N/A,N/A,${link}\n`;
  fs.appendFileSync(CSV_FILE, csvData);
  console.log(`[Storage] Saved: ${type} - ${date}`);
}

/**
 * Check if the filing is already stored
 */
function isFilingStored(date, type, link) {
  const fileData = fs.readFileSync(CSV_FILE, "utf8");
  return fileData.includes(`${date},${type},${link}`);
}

/**
 * Send an email notification for new filings
 */
async function sendEmailNotification(filings) {
  try {
    let filingDetails = filings
      .map(
        (filing) =>
          `<li><strong>${filing.filingType}</strong> - Date: ${filing.filingDate} | <a href="${filing.filingLink}">View Filing</a></li>`
      )
      .join("");

    const emailBody = `
            <h3>🚀 New NVIDIA Investment Filings Detected</h3>
            <p>The following SEC filings were recently published:</p>
            <ul>${filingDetails}</ul>
        `;

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: RECIPIENT_EMAIL,
      subject: `📢 New SEC Filings for NVIDIA`,
      html: emailBody,
    };

    await transporter.sendMail(mailOptions);
    console.log("[Notifier] Email sent successfully!");
  } catch (error) {
    console.error("[Notifier] Error sending email:", error.message);
  }
}

// **Optimized Scraper Timing Based on SEC Filing Patterns**
// 1️⃣ Every Hour: **Track 13F-HR, 8-K, 13D, 13G**
cron.schedule("0 * * * *", () => {
  scrapeSecFilings(HIGH_PRIORITY_FILINGS);
  console.log("[Cron] Hourly high-priority SEC filings check executed.");
});

// 2️⃣ Peak Filing Windows (4 times per day) **10 AM, 1 PM, 4:30 PM, 8 PM ET**
cron.schedule("0 10,13,16,20 * * *", () => {
  scrapeSecFilings(HIGH_PRIORITY_FILINGS);
  console.log("[Cron] Peak SEC filings check executed.");
});

// 3️⃣ Long-Term Reports (4 times per day) **6 AM, 12 PM, 6 PM, 11 PM ET**
cron.schedule("0 6,12,18,23 * * *", () => {
  scrapeSecFilings(LONG_TERM_FILINGS);
  console.log("[Cron] Long-term SEC filings check executed.");
});

// 4️⃣ **Manual Trigger Endpoint**: `/run-scraper`
app.get("/run-scraper", async (req, res) => {
  console.log("[Manual Trigger] Running SEC filings check on demand...");
  const filings = await scrapeSecFilings([
    ...HIGH_PRIORITY_FILINGS,
    ...LONG_TERM_FILINGS,
  ]);

  if (filings.length > 0) {
    res.json({
      status: "success",
      message: `Found ${filings.length} new filings. Email sent!`,
      filings,
    });
  } else {
    res.json({ status: "success", message: "No new filings found." });
  }
});

// 5️⃣ Health Check Endpoint: `/health`
app.get("/health", (req, res) => {
  res.json({ status: "Running", lastChecked: new Date().toISOString() });
});

// Start Server
app.listen(PORT, () => {
  console.log(`[Server] Running on http://localhost:${PORT}`);
  scrapeSecFilings(HIGH_PRIORITY_FILINGS); // Run immediately on startup
});

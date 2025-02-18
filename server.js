require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cron = require("node-cron");
const nodemailer = require("nodemailer");

const app = express();
const PORT = process.env.PORT || 3000;

// Validate Environment Variables
if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
  throw new Error("Missing email credentials in environment variables.");
}
if (!process.env.RECIPIENT_EMAILS) {
  throw new Error("Missing recipient emails in environment variables.");
}

const RECIPIENT_EMAILS = process.env.RECIPIENT_EMAILS.split(",");

// Email Configuration
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// SEC Filings to Track (Only fetch last 2 filings)
const CIK = process.env.CIK || "0001045810"; // Default: NVIDIA
const SEC_URLS = {
  "13F-HR": `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${CIK}&type=13F-HR&dateb=&owner=exclude&count=2`,
  "SC 13D": `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${CIK}&type=SC%2013D&dateb=&owner=exclude&count=2`,
  "SC 13G": `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${CIK}&type=SC%2013G&dateb=&owner=exclude&count=2`,
};

// Fetch SEC Data with Retry Logic
async function fetchWithRetry(url, retries = 3, delay = 3000) {
  const headers = {
    "User-Agent": "Mozilla/5.0",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://www.sec.gov/",
  };

  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get(url, { headers });
      return response.data;
    } catch (error) {
      if (
        error.response &&
        [403, 500, 502, 503, 504].includes(error.response.status)
      ) {
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

// Scrape SEC Filings and List Only the Latest 2 Filings
async function scrapeSecFilings() {
  let newFilings = {};

  for (const [filingType, url] of Object.entries(SEC_URLS)) {
    console.log(
      `📂 [Scraper] Checking latest ${filingType} filings from SEC...`
    );
    try {
      const data = await fetchWithRetry(url);
      const $ = cheerio.load(data);
      let filings = [];

      $("tr").each((index, element) => {
        const linkElement = $(element).find(
          "td:nth-child(2) a[href*='Archives/edgar/data']"
        );
        const filingDate = $(element).find("td:nth-child(4)").text().trim();

        if (linkElement.length > 0 && filingDate) {
          const filingLink = "https://www.sec.gov" + linkElement.attr("href");
          filings.push({ filingDate, filingLink });
        }
      });

      // Ensure only the latest 2 filings are selected
      if (filings.length > 2) {
        filings = filings.slice(0, 2);
      }

      // Log fetched data
      console.log(`🔍 [Fetched] ${filingType} Filings Found:`);
      console.table(filings);

      if (filings.length === 2) {
        newFilings[filingType] = [filings[0], filings[1]];
      }
    } catch (error) {
      console.error(`[Scraper] Error fetching SEC filings: ${error.message}`);
    }
  }

  if (Object.keys(newFilings).length > 0) {
    console.log(`📊 [Scraper] Processing last 2 filings for all types...`);

    for (const [filingType, filings] of Object.entries(newFilings)) {
      console.log(`📄 **Latest ${filingType} Filings:**`);
      console.log(`📅 ${filings[0].filingDate} → ${filings[0].filingLink}`);
      console.log(`📅 ${filings[1].filingDate} → ${filings[1].filingLink}`);
    }

    // Send a single consolidated email for all new filings
    await sendEmailNotification(newFilings);
  } else {
    console.log("❌ [Scraper] No new filings detected.");
  }
}

// Send a single consolidated email with all new filings
async function sendEmailNotification(newFilings) {
  try {
    let emailContent = `
            <h2>📢 New SEC Filings Detected</h2>
            <p>The following filings were recently published:</p>
            <ul>
        `;

    for (const [filingType, filings] of Object.entries(newFilings)) {
      emailContent += `<h3>📜 ${filingType}</h3>`;
      filings.forEach((filing) => {
        emailContent += `<li><strong>${filing.filingDate}</strong> - <a href="${filing.filingLink}">View Filing</a></li>`;
      });
    }

    emailContent += `</ul>`;

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: RECIPIENT_EMAILS,
      subject: `📜 New SEC Filings Available`,
      html: emailContent,
    });

    console.log(`✅ [Email Sent] SEC filings summary email has been sent.`);
  } catch (error) {
    console.error("[Email Error] Failed to send email:", error.message);
  }
}

// Cron Job: Check for New Filings Every Hour
cron.schedule("0 * * * *", async () => {
  console.log("⏳ [Cron] Running scheduled SEC filings check...");
  await scrapeSecFilings();
});

// API Endpoints
app.get("/run-scraper", async (req, res) => {
  console.log("🚀 [Manual Trigger] Running SEC filings scraper now...");
  await scrapeSecFilings();
  res.send("SEC filings scraper executed.");
});

app.get("/health", (req, res) => {
  res.json({ status: "Running", lastChecked: new Date().toISOString() });
});

// Start Server
app.listen(PORT, () => {
  console.log(`[Server] Running on port ${PORT}`);
  scrapeSecFilings().catch((error) =>
    console.error("[Server] Initial scraping error:", error)
  );
});

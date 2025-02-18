# 📊 NVIDIA SEC Filings Scraper

> A powerful **Node.js-based SEC filings tracker** that monitors **NVIDIA's investment activities**, tracks **new positions, stake changes, and exits**, and **sends email alerts** when significant filings are detected.

---

## 📌 Summary

The **NVIDIA SEC Filings Scraper** is a **fully automated** web scraper that:

- Monitors **SEC filings for NVIDIA** (13F-HR, 8-K, SC 13D, SC 13G, 10-Q, 10-K).
- **Identifies changes in investments** (new stakes, increased/reduced holdings, exits).
- **Sends email notifications** when relevant filings are detected.
- Stores data in a **CSV file** for historical tracking.
- Runs **on a schedule** (optimized based on SEC filing patterns).
- Allows **manual triggering** via API.

This tool is **essential for investors, analysts, and researchers** tracking NVIDIA’s financial activities.

---

## 🔍 How It Works

### ✅ Logic & Workflow

1. **Scraper Initialization**:
   - Connects to the **SEC EDGAR database** to fetch **recent filings** for NVIDIA.
2. **Filings Extraction**:

   - Identifies filings of interest (**13F-HR, 8-K, SC 13D, SC 13G, 10-Q, 10-K**).
   - Extracts filing type, date, and direct SEC link.

3. **Comparison with Previous Data**:

   - Compares new filings with **previously recorded filings (CSV)**.
   - Detects **new investment positions, stake changes, or exits**.

4. **Email Notifications**:

   - Sends an **email alert** with a **summary of new filings**.

5. **Scheduling & Automation**:

   - Runs **hourly** for high-priority filings.
   - Checks **4 times a day** for peak SEC filing times.
   - Runs **4 times a day** for long-term financial reports.

6. **Manual Trigger (On-Demand Scraping)**:
   - Provides a **`/run-scraper` API** for instant SEC filing updates.

---

## 📝 Code Explanation

### 1️⃣ `server.js`

- **Main entry point** of the application.
- Sets up the **Express server** with:
  - **SEC Scraper** logic.
  - **Cron jobs** for automated checks.
  - **Email notifications**.
  - **Health check & manual trigger API**.

### 2️⃣ Scraper Logic

- Uses **Axios** to fetch **SEC EDGAR** data.
- Uses **Cheerio** to extract **filing details** from the SEC website.

### 3️⃣ Storage & Comparison

- **CSV file (`nvidia_sec_filings.csv`)** is used to store **historical filings**.
- Prevents **duplicate notifications** for the same filing.

### 4️⃣ Email Notifications

- Uses **Nodemailer** to send alerts when new filings are detected.

---

## ⚙️ How to Run the Project

### 1️⃣ Clone the Repository

```sh
git clone https://github.com/your-username/nvidia-sec-scraper.git
cd nvidia-sec-scraper
```

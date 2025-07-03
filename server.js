const express = require("express");
const axios = require("axios");
const qs = require("querystring");
require("dotenv").config();

if (process.env.NODE_ENV === "development") {
  axios.interceptors.request.use((request) => {
    console.log("Request:", {
      method: request.method,
      url: request.url,
      headers: request.headers,
      data: request.data,
    });
    return request;
  });

  axios.interceptors.response.use(
    (response) => {
      console.log("Response:", {
        status: response.status,
        headers: response.headers,
        data: response.data,
      });
      return response;
    },
    (error) => {
      console.log("Error Response:", {
        status: error.response?.status,
        headers: error.response?.headers,
        data: error.response?.data,
      });
      return Promise.reject(error);
    }
  );
}
class AmiApiClient {
  constructor(config) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.baseUrl = config.baseUrl || "https://api.am-i.io";
    this.authUrl = config.authUrl || "https://auth.am-i.io";
    this.accessToken = null;
    this.tokenExpiresAt = null;
  }

  // Step 1: Get access token using client credentials flow
  async getAccessToken() {
    // If token is still valid, return it
    if (
      this.accessToken &&
      this.tokenExpiresAt &&
      Date.now() < this.tokenExpiresAt
    ) {
      return this.accessToken;
    }
    try {
      console.log("fetching new token");
      const basicAuth = Buffer.from(
        `${this.clientId}:${this.clientSecret}`
      ).toString("base64");
      const response = await axios.post(
        `${this.authUrl}/oauth2/token?grant_type=client_credentials`,
        {},
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Authorization: `Basic ${basicAuth}`,
            Accept: "application/json",
          },
        }
      );
      this.accessToken = response.data.access_token;
      // expires_in is in seconds
      this.tokenExpiresAt = Date.now() + (response.data.expires_in - 60) * 1000; // 60s buffer
      return this.accessToken;
    } catch (error) {
      throw new Error(
        `Client credentials token request failed: ${
          error.response?.data?.error || error.message
        }`
      );
    }
  }

  // Create a lead using the API
  async createLead(leadData) {
    const token = await this.getAccessToken();
    try {
      const response = await axios.post(
        `${this.baseUrl}/crm/v1/leads`,
        leadData,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
        }
      );
      return response.data;
    } catch (error) {
      const statusCode = error.response?.status;

      // Retry once on 401 (Unauthorized) or 403 (Forbidden) errors
      if (statusCode === 401 || statusCode === 403) {
        console.log(
          `First attempt failed with status ${statusCode}, refreshing token and retrying...`
        );
        // Clear the current token to force a refresh
        this.accessToken = null;
        this.tokenExpiresAt = null;

        // Retry with fresh token
        const freshToken = await this.getAccessToken();
        const retryResponse = await axios.post(
          `${this.baseUrl}/crm/v1/leads`,
          leadData,
          {
            headers: {
              Authorization: `Bearer ${freshToken}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
          }
        );
        return retryResponse.data;
      }

      throw new Error(
        `Lead creation failed: ${
          error.response?.data?.message || error.message
        }`
      );
    }
  }
}

// Express server setup
const app = express();
app.use(express.json());

/**
 * AM-I API Configuration
 *
 * IMPORTANT: Keep all sensitive credentials in environment variables for security.
 * Never commit these values directly to version control.
 *
 * Required environment variables:
 * - AMI_CLIENT_ID: Your AM-I client ID
 * - AMI_CLIENT_SECRET: Your AM-I client secret
 *
 * Optional environment variables:
 * - AMI_BASE_URL: AM-I API base URL (defaults to production URL)
 * - AMI_AUTH_URL: AM-I authentication URL (defaults to production URL)
 *
 * Create a .env file in your project root with these variables:
 * ```
 * AMI_CLIENT_ID=your_actual_client_id
 * AMI_CLIENT_SECRET=your_actual_client_secret
 * AMI_BASE_URL=https://client-api.am-i.nl/public
 * AMI_AUTH_URL=https://external-api-auth.am-i.io
 * ```
 *
 * Make sure to add .env to your .gitignore file to prevent accidental commits.
 */
const apiConfig = {
  clientId: process.env.AMI_CLIENT_ID || "your_client_id",
  clientSecret: process.env.AMI_CLIENT_SECRET || "your_client_secret",
  baseUrl: process.env.AMI_BASE_URL || "https://client-api.am-i.nl/public",
  authUrl: process.env.AMI_AUTH_URL || "https://external-api-auth.am-i.nl",
};

const amiApiClient = new AmiApiClient(apiConfig);

// Route: Create a lead
app.post("/leads", async (req, res) => {
  try {
    // Add input validation - validate required fields
    const leadData = {
      initiative: req.body.initiative,
      source: req.body.source,
      leadType: req.body.leadType,
      dealerId: req.body.dealerId,
      prospect: {
        lastName: req.body.prospect.lastName,
        emailAddress: req.body.prospect.emailAddress,
      },
    };

    const result = await amiApiClient.createLead(leadData);
    res.json({
      success: true,
      message: "Lead created successfully",
      lead: result,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Route: Get current token status
app.get("/token-status", async (req, res) => {
  try {
    const token = await amiApiClient.getAccessToken();
    res.json({
      hasAccessToken: !!token,
      tokenExpiresAt: amiApiClient.tokenExpiresAt,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Route: Health check
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error("Server error:", error);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Token status: http://localhost:${PORT}/token-status`);
  console.log(`Create lead: http://localhost:${PORT}/leads`);
});

module.exports = { AmiApiClient, app };

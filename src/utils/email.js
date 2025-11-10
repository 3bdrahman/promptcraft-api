/**
 * Email Service - Resend Implementation
 *
 * SETUP INSTRUCTIONS:
 *
 * Development Mode (Current - works out of the box):
 * - PINs are logged to console
 * - No email actually sent
 * - Perfect for testing locally
 *
 * Production Setup (5 minutes):
 * 1. Install Resend: npm install resend
 * 2. Sign up at https://resend.com (FREE - 3,000 emails/month)
 * 3. Get your API key from the dashboard
 * 4. Add to your .env or Vercel environment variables:
 *    RESEND_API_KEY=re_xxxxxxxxxxxxx
 *    FROM_EMAIL=noreply@yourdomain.com
 *    NODE_ENV=production
 * 5. Verify your domain in Resend dashboard (adds SPF/DKIM records)
 * 6. Done! Emails will be delivered with 99.9% deliverability
 *
 * Pricing:
 * - 0-3,000 emails/month: FREE ✅
 * - 3,000-50,000: $20/month
 * - 50,000-100,000: $60/month
 *
 * Domain Verification:
 * - You can test with @resend.dev domain immediately
 * - For production, verify your own domain for better deliverability
 */

// ============================================================================
// EMAIL PROVIDER - Resend
// ============================================================================

// Import Resend - only used in production when RESEND_API_KEY is set
import { Resend } from 'resend';

let resend = null;

function getResendClient() {
  if (!process.env.RESEND_API_KEY) {
    return null;
  }

  if (!resend) {
    resend = new Resend(process.env.RESEND_API_KEY);
  }

  return resend;
}

// ============================================================================
// CONFIGURATION
// ============================================================================

const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev';
const APP_NAME = 'PromptCraft';
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@promptcraft.ai';

// ============================================================================
// EMAIL TEMPLATES
// ============================================================================

function getVerificationPinTemplate(pin, expiryMinutes = 15) {
  return {
    subject: `${APP_NAME} - Email Verification Code`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Email Verification</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
          }
          .container {
            background: #ffffff;
            border-radius: 8px;
            padding: 40px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          }
          .header {
            text-align: center;
            margin-bottom: 30px;
          }
          .logo {
            font-size: 24px;
            font-weight: bold;
            color: #6366f1;
          }
          .pin-container {
            background: #f8f9fa;
            border: 2px dashed #6366f1;
            border-radius: 8px;
            padding: 30px;
            text-align: center;
            margin: 30px 0;
          }
          .pin {
            font-size: 48px;
            font-weight: bold;
            letter-spacing: 8px;
            color: #6366f1;
            font-family: 'Courier New', monospace;
          }
          .expiry {
            color: #6b7280;
            font-size: 14px;
            margin-top: 10px;
          }
          .footer {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #e5e7eb;
            font-size: 14px;
            color: #6b7280;
            text-align: center;
          }
          .warning {
            background: #fef3c7;
            border-left: 4px solid #f59e0b;
            padding: 15px;
            margin: 20px 0;
            font-size: 14px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo">${APP_NAME}</div>
          </div>

          <h1>Verify Your Email Address</h1>
          <p>Welcome to ${APP_NAME}! To complete your registration, please use the verification code below:</p>

          <div class="pin-container">
            <div class="pin">${pin}</div>
            <div class="expiry">This code expires in ${expiryMinutes} minutes</div>
          </div>

          <div class="warning">
            <strong>Security Note:</strong> If you didn't request this code, please ignore this email. Never share this code with anyone.
          </div>

          <p>If you have any questions, please contact us at <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>

          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} ${APP_NAME}. All rights reserved.</p>
            <p>This is an automated message, please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `,
    text: `
${APP_NAME} - Email Verification

Welcome to ${APP_NAME}!

Your verification code is: ${pin}

This code expires in ${expiryMinutes} minutes.

If you didn't request this code, please ignore this email.

Questions? Contact us at ${SUPPORT_EMAIL}

© ${new Date().getFullYear()} ${APP_NAME}
    `.trim()
  };
}

function getWelcomeEmailTemplate(username) {
  return {
    subject: `Welcome to ${APP_NAME}!`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Welcome to ${APP_NAME}</title>
      </head>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="background: #ffffff; border-radius: 8px; padding: 40px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
          <h1 style="color: #6366f1;">Welcome, ${username}! 🎉</h1>
          <p>Your email has been verified successfully and your account is now active.</p>
          <p>You can now:</p>
          <ul>
            <li>Create and manage AI prompt templates</li>
            <li>Build context layers for better AI interactions</li>
            <li>Sync across all your devices with the browser extension</li>
          </ul>
          <p>Get started by visiting your dashboard!</p>
          <p style="margin-top: 30px;">Best regards,<br>The ${APP_NAME} Team</p>
        </div>
      </body>
      </html>
    `,
    text: `
Welcome, ${username}! 🎉

Your email has been verified successfully and your account is now active.

You can now:
- Create and manage AI prompt templates
- Build context layers for better AI interactions
- Sync across all your devices with the browser extension

Get started by visiting your dashboard!

Best regards,
The ${APP_NAME} Team
    `.trim()
  };
}

// ============================================================================
// EMAIL SENDING FUNCTIONS
// ============================================================================

/**
 * Send verification PIN email
 */
export async function sendVerificationPin(to, pin, expiryMinutes = 15) {
  const template = getVerificationPinTemplate(pin, expiryMinutes);

  try {
    // DEVELOPMENT MODE - Just log the PIN
    if (process.env.NODE_ENV === 'development' || !process.env.RESEND_API_KEY) {
      console.log('\n📧 ============================================');
      console.log('📧 EMAIL VERIFICATION PIN (Development Mode)');
      console.log('📧 ============================================');
      console.log(`📧 To: ${to}`);
      console.log(`📧 PIN: ${pin}`);
      console.log(`📧 Expires in: ${expiryMinutes} minutes`);
      console.log('📧 ============================================\n');
      return { success: true, messageId: 'dev-mode' };
    }

    // PRODUCTION MODE - Send via Resend
    const resendClient = getResendClient();

    if (!resendClient) {
      throw new Error('Resend API key not configured. Set RESEND_API_KEY environment variable.');
    }

    const { data, error } = await resendClient.emails.send({
      from: FROM_EMAIL,
      to,
      subject: template.subject,
      html: template.html,
      text: template.text
    });

    if (error) {
      throw error;
    }

    console.log(`✅ Verification PIN sent via Resend to: ${to} (ID: ${data.id})`);

    return {
      success: true,
      messageId: data.id,
      provider: 'resend'
    };

  } catch (error) {
    console.error('❌ Failed to send verification PIN:', error);
    throw error;
  }
}

/**
 * Send welcome email after verification
 */
export async function sendWelcomeEmail(to, username) {
  const template = getWelcomeEmailTemplate(username);

  try {
    // DEVELOPMENT MODE - Just log
    if (process.env.NODE_ENV === 'development' || !process.env.RESEND_API_KEY) {
      console.log(`📧 Would send welcome email to: ${to} (username: ${username})`);
      return { success: true, messageId: 'dev-mode' };
    }

    // PRODUCTION MODE - Send via Resend
    const resendClient = getResendClient();

    if (!resendClient) {
      console.log('⚠️  Resend not configured, skipping welcome email');
      return { success: false, error: 'Resend not configured' };
    }

    const { data, error } = await resendClient.emails.send({
      from: FROM_EMAIL,
      to,
      subject: template.subject,
      html: template.html,
      text: template.text
    });

    if (error) {
      throw error;
    }

    console.log(`✅ Welcome email sent via Resend to: ${to}`);

    return {
      success: true,
      messageId: data.id,
      provider: 'resend'
    };

  } catch (error) {
    console.error('❌ Failed to send welcome email:', error);
    // Don't throw - welcome email is nice-to-have, not critical
    return { success: false, error: error.message };
  }
}

/**
 * Generate a random 6-digit PIN
 */
export function generatePin() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

export default {
  sendVerificationPin,
  sendWelcomeEmail,
  generatePin
};

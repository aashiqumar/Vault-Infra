import * as functions from 'firebase-functions';
import { onDocumentCreated, onDocumentUpdated } from 'firebase-functions/v2/firestore';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { Resend } from 'resend';

admin.initializeApp();

const getResendApiKey = (): string => {
  try {
    return process.env.RESEND_API_KEY || (functions as any).config?.()?.resend?.api_key || '';
  } catch (e) {
    return process.env.RESEND_API_KEY || '';
  }
};

const resend = new Resend(getResendApiKey() || 're_placeholder');
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'Vault Pro <notifications@vaultpro.cloud>';

/** Derive the tenant's public base URL.
 *  clubId is the Firestore document ID which may be a UUID; the subdomain
 *  is the club's `slug` field.  Fetch it and fall back to clubId on error. */
async function getClubBaseUrl(clubId: string): Promise<string> {
  try {
    const snap = await admin.firestore().collection('clubs').doc(clubId).get();
    const slug: string = snap.data()?.slug || clubId;
    return `https://${slug}.vaultpro.cloud`;
  } catch {
    return `https://${clubId}.vaultpro.cloud`;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Write in-app notification doc + dispatch FCM push to all device tokens. */
async function sendNotificationToUser(
  toUid: string,
  clubId: string,
  title: string,
  message: string,
  type: string,
  link?: string
) {
  try {
    const notifDocRef = await admin.firestore().collection('notifications').add({
      toUid,
      clubId,
      title,
      message,
      type,
      link: link || null,
      read: false,
      timestamp: FieldValue.serverTimestamp(),
    });

    const userSnap = await admin.firestore().collection('users').doc(toUid).get();
    const fcmTokens: string[] = userSnap.data()?.fcmTokens || [];

    if (fcmTokens.length > 0) {
      const baseUrl = await getClubBaseUrl(clubId);
      const payload = {
        notification: { title, body: message },
        data: {
          click_action: link ? `${baseUrl}${link}` : `${baseUrl}/`,
          type,
          clubId,
          notificationId: notifDocRef.id,
        },
      };
      await Promise.all(
        fcmTokens.map(async (token) => {
          try {
            await admin.messaging().send({ token, notification: payload.notification, data: payload.data });
          } catch (err: any) {
            if (
              err.code === 'messaging/invalid-registration-token' ||
              err.code === 'messaging/registration-token-not-registered'
            ) {
              await admin.firestore().collection('users').doc(toUid).update({
                fcmTokens: FieldValue.arrayRemove(token),
              });
            }
          }
        })
      );
    }
  } catch (error) {
    console.error(`sendNotificationToUser failed for uid=${toUid}:`, error);
  }
}

/**
 * Send a single email via Resend.
 * Always wraps in try/catch so a failed email never crashes a trigger.
 */
async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  try {
    const response = await resend.emails.send({ from: FROM_EMAIL, to, subject, html });
    if (response.error) {
      console.error(`[Resend] Failed to send to ${to}:`, response.error);
    }
  } catch (err) {
    console.error(`[Resend] Exception sending to ${to}:`, err);
  }
}

/** Visibility gate — mirrors the frontend logic. */
function matchesVisibility(
  profile: { role?: string; isBoardMember?: boolean; isExcoMember?: boolean },
  visibility: string | undefined
): boolean {
  if (visibility === 'BOARD') return profile.isBoardMember === true || profile.role === 'ADMIN';
  if (visibility === 'EXCO') return profile.isExcoMember === true || profile.role === 'ADMIN';
  return true; // GENERAL or undefined → all verified members
}

// ─── Email HTML templates ──────────────────────────────────────────────────────

/** Escape HTML special characters to prevent injection in email templates. */
function escapeHtml(text: string): string {
  if (!text) return '';
  const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
  return text.replace(/[&<>"']/g, m => map[m]);
}

/** Normalise any date string to "18 Jul 2026" — strips ISO timestamps. */
function formatDateOnly(dateStr: string): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return escapeHtml(dateStr);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function row(label: string, value: string, valueStyle = 'color:#1e293b;font-size:15px;font-weight:700;'): string {
  return `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #f1f5f9;vertical-align:top;width:38%;">
        <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#94a3b8;">${label}</span>
      </td>
      <td style="padding:12px 0 12px 16px;border-bottom:1px solid #f1f5f9;vertical-align:top;">
        <span style="${valueStyle}">${value}</span>
      </td>
    </tr>`;
}

function wrapEmailShell(accentColor: string, iconEmoji: string, preheader: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;color:#f1f5f9;">${preheader}</div>
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
    <tr><td align="center" style="padding:40px 16px 48px;">

      <!-- Card -->
      <table width="560" cellpadding="0" cellspacing="0" role="presentation"
             style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;box-shadow:0 4px 24px rgba(0,0,0,0.06);">

        <!-- Accent bar -->
        <tr><td style="background:${accentColor};height:4px;font-size:0;">&nbsp;</td></tr>

        <!-- Header -->
        <tr><td style="padding:24px 32px 20px;background:#0f172a;">
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
            <tr>
              <td>
                <span style="font-size:11px;font-weight:800;letter-spacing:4px;text-transform:uppercase;color:#6366f1;">VAULT PRO</span>
              </td>
              <td align="right">
                <span style="font-size:22px;">${iconEmoji}</span>
              </td>
            </tr>
          </table>
        </td></tr>

        <!-- Body -->
        <tr><td style="padding:32px 32px 28px;">${bodyHtml}</td></tr>

        <!-- Footer -->
        <tr><td style="padding:20px 32px;border-top:1px solid #f1f5f9;background:#f8fafc;">
          <p style="margin:0;font-size:11px;color:#94a3b8;text-align:center;line-height:1.6;">
            You received this email because you are a member of a club on Vault Pro.<br>
            <a href="https://vaultpro.cloud" style="color:#6366f1;text-decoration:none;font-weight:600;">vaultpro.cloud</a>
          </p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function ctaButton(href: string, label: string, color = '#6366f1'): string {
  return `<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-top:24px;">
    <tr><td>
      <a href="${href}"
         style="display:block;background:${color};color:#ffffff;text-align:center;text-decoration:none;
                font-weight:700;font-size:14px;padding:14px 28px;border-radius:8px;letter-spacing:0.3px;">
        ${label}
      </a>
    </td></tr>
  </table>`;
}

/** Deep link to a specific transaction; falls back to the list when no id. */
function transactionsLink(baseUrl: string, paymentId?: string): string {
  return paymentId ? `${baseUrl}/transactions?id=${paymentId}` : `${baseUrl}/transactions`;
}

const KIND_LABELS: Record<string, string> = {
  PROJECT_PROPOSAL: 'Project Proposal',
  PROJECT_REPORT: 'Project Report',
  TRANSACTION: 'Transaction',
  MEMBER_ONBOARDING: 'Member Onboarding',
  RESIGNATION: 'Resignation',
  CLUB_TRANSFER: 'Club Transfer',
  ARTICLE_PUBLISH: 'Article Publishing',
};

/**
 * Returns the deep link a user should land on after an approval is RESOLVED.
 * The inbox only shows PENDING items, so post-resolution we link to the source document.
 */
function resolvedSourceLink(kind: string, refId: string, approvalId: string): string {
  if (kind === 'TRANSACTION') return `/transactions?id=${refId}`;
  if (kind === 'PROJECT_PROPOSAL' || kind === 'PROJECT_REPORT') return `/resources?id=${refId}`;
  if (kind === 'ARTICLE_PUBLISH') return `/articles?id=${refId}`;
  if (kind === 'MEMBER_ONBOARDING' || kind === 'RESIGNATION' || kind === 'CLUB_TRANSFER') return `/members?id=${refId}`;
  return `/approvals?id=${approvalId}`;
}

/** Email sent to approvers when a new approval request arrives. */
function emailApprovalRequest(
  kindLabel: string,
  title: string,
  summary: string,
  requestedByName: string,
  approvalLink: string
): string {
  const body = `
    <p style="margin:0 0 6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#6366f1;">${escapeHtml(kindLabel)}</p>
    <h1 style="margin:0 0 4px;font-size:20px;font-weight:800;color:#1e293b;">Review Required</h1>
    <p style="margin:0 0 24px;font-size:13px;color:#64748b;line-height:1.5;">A new ${escapeHtml(kindLabel.toLowerCase())} is awaiting your approval.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:0 20px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          ${row('Title', escapeHtml(title), 'font-size:15px;font-weight:700;color:#1e293b;')}
          ${row('Submitted By', escapeHtml(requestedByName))}
          ${summary ? row('Summary', escapeHtml(summary), 'color:#475569;font-size:13px;font-weight:400;line-height:1.5;') : ''}
        </table>
      </td></tr>
    </table>
    ${ctaButton(approvalLink, 'Review & Approve →', '#6366f1')}`;
  return wrapEmailShell('#6366f1', '📋', `${escapeHtml(kindLabel)} pending your approval: ${escapeHtml(title)}`, body);
}

function emailPaymentPending(memberName: string, amount: number, description: string, date: string, baseUrl: string, paymentId?: string): string {
  const body = `
    <h1 style="margin:0 0 4px;font-size:20px;font-weight:800;color:#1e293b;">Payment Pending Verification</h1>
    <p style="margin:0 0 24px;font-size:13px;color:#64748b;line-height:1.5;">A new payment has been logged and is awaiting your review.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:0 20px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          ${row('Member', escapeHtml(memberName))}
          ${row('Amount', `LKR ${amount.toLocaleString()}`, 'color:#6366f1;font-size:22px;font-weight:900;')}
          ${row('Description', escapeHtml(description || '—'), 'color:#334155;font-size:14px;font-weight:500;')}
          ${row('Date', formatDateOnly(date), 'color:#475569;font-size:14px;font-weight:600;')}
        </table>
      </td></tr>
    </table>
    ${ctaButton(transactionsLink(baseUrl, paymentId), 'Review Payment →')}`;
  return wrapEmailShell('#6366f1', '💳', `${escapeHtml(memberName)} logged LKR ${amount.toLocaleString()} — review required`, body);
}

function emailPaymentApproved(amount: number, approvedByName: string, description: string, baseUrl: string, paymentId?: string): string {
  const body = `
    <h1 style="margin:0 0 4px;font-size:20px;font-weight:800;color:#1e293b;">Payment Approved</h1>
    <p style="margin:0 0 24px;font-size:13px;color:#64748b;line-height:1.5;">Your payment has been verified and approved.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #bbf7d0;border-radius:8px;overflow:hidden;background:#f0fdf4;">
      <tr><td style="padding:0 20px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          ${row('Amount', `LKR ${amount.toLocaleString()}`, 'color:#15803d;font-size:22px;font-weight:900;')}
          ${row('Description', escapeHtml(description || '—'), 'color:#166534;font-size:14px;font-weight:500;')}
          ${row('Approved by', escapeHtml(approvedByName), 'color:#166534;font-size:14px;font-weight:700;')}
        </table>
      </td></tr>
    </table>
    ${ctaButton(transactionsLink(baseUrl, paymentId), 'View Transaction →', '#16a34a')}`;
  return wrapEmailShell('#16a34a', '✅', `Your payment of LKR ${amount.toLocaleString()} was approved`, body);
}

function emailPaymentRejected(amount: number, rejectionReason: string, description: string, baseUrl: string, paymentId?: string): string {
  const body = `
    <h1 style="margin:0 0 4px;font-size:20px;font-weight:800;color:#1e293b;">Payment Rejected</h1>
    <p style="margin:0 0 24px;font-size:13px;color:#64748b;line-height:1.5;">Your payment was not approved.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #fecaca;border-radius:8px;overflow:hidden;background:#fef2f2;">
      <tr><td style="padding:0 20px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          ${row('Amount', `LKR ${amount.toLocaleString()}`, 'color:#dc2626;font-size:22px;font-weight:900;')}
          ${row('Description', escapeHtml(description || '—'), 'color:#334155;font-size:14px;font-weight:500;')}
          ${row('Reason', escapeHtml(rejectionReason), 'color:#dc2626;font-size:14px;font-weight:600;')}
        </table>
      </td></tr>
    </table>
    ${ctaButton(transactionsLink(baseUrl, paymentId), 'View Transaction →')}`;
  return wrapEmailShell('#dc2626', '❌', `Payment of LKR ${amount.toLocaleString()} rejected — ${escapeHtml(rejectionReason)}`, body);
}

/** Email template for approval/rejection notifications. */
function emailApprovalNotification(
  title: string,
  kind: string,
  status: string,
  decisionBy: string,
  baseUrl: string,
  link: string
): string {
  const isApproved = status === 'APPROVED';
  const accentColor = isApproved ? '#059669' : '#dc2626';
  const emoji = isApproved ? '✅' : '❌';
  const body = `
    <h1 style="margin:0 0 4px;font-size:20px;font-weight:800;color:#1e293b;">${isApproved ? 'Approved' : 'Rejected'}</h1>
    <p style="margin:0 0 24px;font-size:13px;color:#64748b;line-height:1.5;">
      ${isApproved ? 'Your request has been approved.' : 'Your request has been rejected.'}
    </p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:0 20px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          ${row('Title', escapeHtml(title))}
          ${row('Type', kind.replace(/_/g, ' '))}
          ${row('Decision', status, isApproved ? 'color:#059669;font-size:16px;font-weight:800;' : 'color:#dc2626;font-size:16px;font-weight:800;')}
          ${row('By', escapeHtml(decisionBy))}
        </table>
      </td></tr>
    </table>
    ${ctaButton(`${baseUrl}${link}`, 'View Details →')}`;
  return wrapEmailShell(accentColor, emoji, `${title} — ${status} by ${escapeHtml(decisionBy)}`, body);
}

function emailEventCreated(
  title: string,
  type: string,
  date: string,
  time: string,
  location: string,
  description: string,
  eventId: string,
  baseUrl: string
): string {
  const body = `
    <p style="margin:0 0 6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#6366f1;">${escapeHtml(type)}</p>
    <h1 style="margin:0 0 4px;font-size:22px;font-weight:800;color:#1e293b;">${escapeHtml(title)}</h1>
    <p style="margin:0 0 24px;font-size:13px;color:#64748b;line-height:1.5;">A new event has been scheduled for your club.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:0 20px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          ${row('Date', formatDateOnly(date))}
          ${row('Time', escapeHtml(time), 'color:#1e293b;font-size:15px;font-weight:700;')}
          ${row('Location', escapeHtml(location), 'color:#475569;font-size:14px;font-weight:600;')}
          ${description ? row('About', escapeHtml(description), 'color:#64748b;font-size:13px;font-weight:400;line-height:1.5;') : ''}
        </table>
      </td></tr>
    </table>
    ${ctaButton(`${baseUrl}/events?id=${eventId}`, 'View Event →')}`;
  return wrapEmailShell('#6366f1', '📅', `New ${escapeHtml(type)}: ${escapeHtml(title)} on ${formatDateOnly(date)}`, body);
}

function emailAnnouncement(
  eventTitle: string,
  eventDate: string,
  eventTime: string,
  eventLocation: string,
  announcementType: string,
  message: string,
  postedByName: string,
  eventId: string,
  baseUrl: string
): string {
  const typeConfig: Record<string, { bg: string; border: string; text: string; accent: string; emoji: string }> = {
    URGENT:  { bg: '#fff1f2', border: '#fecdd3', text: '#be123c', accent: '#be123c', emoji: '🚨' },
    WARNING: { bg: '#fffbeb', border: '#fde68a', text: '#92400e', accent: '#d97706', emoji: '⚠️' },
    UPDATE:  { bg: '#eff6ff', border: '#bfdbfe', text: '#1d4ed8', accent: '#3b82f6', emoji: '🔄' },
    INFO:    { bg: '#f0fdf4', border: '#bbf7d0', text: '#166534', accent: '#16a34a', emoji: 'ℹ️' },
  };
  const c = typeConfig[announcementType] || typeConfig['INFO'];
  const body = `
    <p style="margin:0 0 6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#6366f1;">Event Announcement</p>
    <h1 style="margin:0 0 4px;font-size:20px;font-weight:800;color:#1e293b;">${escapeHtml(eventTitle)}</h1>
    <p style="margin:0 0 20px;font-size:13px;color:#94a3b8;">
      ${formatDateOnly(eventDate)}${eventTime ? ' · ' + escapeHtml(eventTime) : ''}${eventLocation ? ' · ' + escapeHtml(eventLocation) : ''}
    </p>
    <table width="100%" cellpadding="0" cellspacing="0"
           style="background:${c.bg};border:1px solid ${c.border};border-radius:8px;margin-bottom:4px;">
      <tr>
        <td style="width:4px;background:${c.accent};border-radius:8px 0 0 8px;">&nbsp;</td>
        <td style="padding:16px 20px;">
          <p style="margin:0 0 6px;font-size:10px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:${c.text};">
            ${c.emoji} ${escapeHtml(announcementType)}
          </p>
          <p style="margin:0;font-size:15px;color:#1e293b;line-height:1.65;">${escapeHtml(message)}</p>
        </td>
      </tr>
    </table>
    <p style="margin:6px 0 0;font-size:11px;color:#94a3b8;">Posted by <strong style="color:#64748b;">${escapeHtml(postedByName)}</strong></p>
    ${ctaButton(`${baseUrl}/events?id=${eventId}`, 'View Event →')}`;
  return wrapEmailShell(c.accent, c.emoji, `${escapeHtml(announcementType)}: ${escapeHtml(eventTitle)} — ${formatDateOnly(eventDate)}`, body);
}

function emailNewMemberRequest(name: string, email: string, whatsapp: string, baseUrl: string): string {
  const body = `
    <h1 style="margin:0 0 4px;font-size:20px;font-weight:800;color:#1e293b;">New Member Request</h1>
    <p style="margin:0 0 24px;font-size:13px;color:#64748b;line-height:1.5;">Someone has applied to join your club and is awaiting approval.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:0 20px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          ${row('Name', escapeHtml(name))}
          ${row('Email', `<a href="mailto:${escapeHtml(email)}" style="color:#6366f1;text-decoration:none;font-weight:600;">${escapeHtml(email)}</a>`, 'font-size:14px;')}
          ${row('WhatsApp', escapeHtml(whatsapp), 'color:#475569;font-size:14px;font-weight:600;')}
        </table>
      </td></tr>
    </table>
    ${ctaButton(`${baseUrl}/members`, 'Review in Members →')}`;
  return wrapEmailShell('#6366f1', '👤', `New member request from ${escapeHtml(name)}`, body);
}

// ─── Cloud Function: Password Reset ───────────────────────────────────────────

export const sendPasswordResetEmail = functions.https.onCall(async (request: any) => {
  const data = request && typeof request === 'object' && 'data' in request ? request.data : request;
  const email = data?.email;
  if (!email) throw new functions.https.HttpsError('invalid-argument', 'Email is required');
  const redirectUrl = data?.redirectUrl || 'https://vaultpro.cloud';

  try {
    let resetLink: string;
    try {
      resetLink = await admin.auth().generatePasswordResetLink(email, { url: redirectUrl });
    } catch (e: any) {
      if (e.code === 'auth/unauthorized-continue-uri') {
        console.warn(`Continue URL domain not allowlisted. Falling back to default reset link.`);
        resetLink = await admin.auth().generatePasswordResetLink(email);
      } else {
        throw e;
      }
    }

    const fromEmail = process.env.RESEND_PASSWORD_RESET_EMAIL || FROM_EMAIL;
    const response = await resend.emails.send({
      from: fromEmail,
      to: email,
      subject: 'Reset your Vault password',
      html: passwordResetEmailHtml(resetLink, email),
    });

    if (response.error) {
      console.error('[Resend API Error]', response.error);
      throw new functions.https.HttpsError('internal', `Email delivery failed: ${response.error.message}`);
    }

    return { success: true };
  } catch (err: any) {
    console.error('[Cloud Function Password Reset Error]', err);
    if (err instanceof functions.https.HttpsError) throw err;
    if (err.code === 'auth/user-not-found')
      throw new functions.https.HttpsError('not-found', 'No user account found with this email address.');
    if (err.code === 'auth/invalid-email')
      throw new functions.https.HttpsError('invalid-argument', 'The email address is badly formatted.');
    throw new functions.https.HttpsError('internal', err.message || 'An error occurred while processing your request.');
  }
});

// ─── Trigger 1: New access/registration request ───────────────────────────────

export const onAccessRequestCreated = onDocumentCreated('accessRequests/{requestId}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  const requestData = snap.data();
  if (!requestData || requestData.status !== 'PENDING') return;

  const { clubId, name, email: applicantEmail, whatsapp } = requestData;

  // Notify all verified ADMINs of this club
  const adminsSnap = await admin.firestore()
    .collection('users')
    .where('clubId', '==', clubId)
    .where('role', '==', 'ADMIN')
    .where('verified', '==', true)
    .get();

  await Promise.all(
    adminsSnap.docs.map(async (adminDoc) => {
      const profile = adminDoc.data();
      await sendNotificationToUser(
        adminDoc.id,
        clubId,
        'New Registration Pending',
        `${name} has requested access to join your club.`,
        'REGISTRATION',
        '/members'
      );
      if (profile.email) {
        await sendEmail(
          profile.email,
          `New member request: ${name}`,
          emailNewMemberRequest(name, applicantEmail || '', whatsapp || '', await getClubBaseUrl(clubId))
        );
      }
    })
  );
});

// ─── Trigger 2: Event created ─────────────────────────────────────────────────

export const onEventCreated = onDocumentCreated('events/{eventId}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  const eventData = snap.data();
  if (!eventData) return;

  const { clubId, title, visibility, date, time, location, description, type } = eventData;
  const eventId = event.params.eventId;

  const usersSnap = await admin.firestore()
    .collection('users')
    .where('clubId', '==', clubId)
    .where('verified', '==', true)
    .get();

  await Promise.all(
    usersSnap.docs.map(async (userDoc) => {
      const profile = userDoc.data();
      if (!matchesVisibility(profile, visibility)) return;

      await sendNotificationToUser(
        userDoc.id,
        clubId,
        `${type || 'Event'} Created: ${title}`,
        `Scheduled on ${date} at ${time} at ${location}.`,
        'EVENT_CREATION',
        `/events?id=${eventId}`
      );

      if (profile.email) {
        await sendEmail(
          profile.email,
          `New ${type || 'Event'}: ${title}`,
          emailEventCreated(title, type || 'Event', date, time, location, description || '', eventId, await getClubBaseUrl(clubId))
        );
      }
    })
  );
});

// ─── Trigger 3: Event announcement posted ────────────────────────────────────

export const onAnnouncementCreated = onDocumentCreated(
  'events/{eventId}/announcements/{announcementId}',
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const ann = snap.data();
    if (!ann) return;

    const { clubId, message, type: annType, postedByName } = ann;
    const eventId = event.params.eventId;

    // Fetch the parent event to get visibility
    const eventSnap = await admin.firestore().collection('events').doc(eventId).get();
    const eventData = eventSnap.data();
    if (!eventData) return;

    const { title: eventTitle, visibility, date: eventDate, time: eventTime, location: eventLocation } = eventData;

    const usersSnap = await admin.firestore()
      .collection('users')
      .where('clubId', '==', clubId)
      .where('verified', '==', true)
      .get();

    await Promise.all(
      usersSnap.docs.map(async (userDoc) => {
        const profile = userDoc.data();
        if (!matchesVisibility(profile, visibility)) return;

        await sendNotificationToUser(
          userDoc.id,
          clubId,
          `[${annType}] ${eventTitle}`,
          message,
          'ANNOUNCEMENT',
          `/events?id=${eventId}`
        );

        if (profile.email) {
          await sendEmail(
            profile.email,
            `${annType === 'URGENT' ? '🚨 ' : ''}${eventTitle} — ${formatDateOnly(eventDate || '')}`,
            emailAnnouncement(eventTitle, eventDate || '', eventTime || '', eventLocation || '', annType || 'INFO', message, postedByName || 'Club Admin', eventId, await getClubBaseUrl(clubId))
          );
        }
      })
    );
  }
);

// ─── Trigger 3: Approval resolved ────────────────────────────────────────────

export const onApprovalResolved = onDocumentUpdated('approvals/{approvalId}', async (event) => {
  const change = event.data;
  if (!change) return;
  const oldData = change.before.data();
  const newData = change.after.data();
  if (!oldData || !newData) return;

  const oldStatus = oldData.status;
  const newStatus = newData.status;
  // Only fire when transitioning out of PENDING
  if (oldStatus !== 'PENDING' || (newStatus !== 'APPROVED' && newStatus !== 'REJECTED')) return;

  const {
    clubId, kind, refCollection, refId, title,
    requestedBy, decisions,
  } = newData;

  const isApproved = newStatus === 'APPROVED';
  const baseUrl = await getClubBaseUrl(clubId);

  // ── Side-effect: PROJECT_PROPOSAL approved → create the project event ──
  // Proposal heavy fields (startDate, description, venues) live in the
  // `resourceDetails` companion doc, NOT the lean `resources` metadata doc.
  if (isApproved && kind === 'PROJECT_PROPOSAL' && refCollection === 'resources') {
    try {
      const [metaSnap, detailSnap] = await Promise.all([
        admin.firestore().collection('resources').doc(refId).get(),
        admin.firestore().collection('resourceDetails').doc(refId).get(),
      ]);
      const meta = metaSnap.data() || {};
      const details = detailSnap.data() || {};
      const commencementDate = details.startDate || meta.startDate;
      if (commencementDate) {
        const eventRef = await admin.firestore().collection('events').add({
          clubId,
          title,
          description: details.description || meta.description || '',
          date: commencementDate, // project commencement date == event date
          time: '18:00',
          location: details.projectVenues || '',
          type: 'Project',
          visibility: 'GENERAL',
          rsvps: {},
          attendance: [],
          sourceProposalId: refId,
          rotaractYear: meta.rotaractYear || '',
        });
        // Back-link + status on the proposal so list ribbons update
        await metaSnap.ref.update({
          status: 'APPROVED',
          linkedEventId: eventRef.id,
          linkedEventTitle: title,
        });
      } else {
        console.error(`onApprovalResolved: proposal ${refId} has no startDate; event not created.`);
        await metaSnap.ref.update({ status: 'APPROVED' });
      }
    } catch (err) {
      console.error(`onApprovalResolved: Failed to create event for proposal ${refId}:`, err);
    }
  }

  // ── Side-effect: resource status write-back for reports & rejected proposals ──
  if (refCollection === 'resources' && (kind === 'PROJECT_REPORT' || (kind === 'PROJECT_PROPOSAL' && !isApproved))) {
    try {
      await admin.firestore().collection('resources').doc(refId).update({
        status: isApproved ? 'APPROVED' : 'REJECTED',
      });
    } catch (err) {
      console.error(`onApprovalResolved: Failed to update resource ${refId} status:`, err);
    }
  }

  // ── Side-effect: ARTICLE_PUBLISH decided → flip the article's status ──
  // Approved: goes live (PUBLISHED). Rejected: reverts to DRAFT (not a dead
  // end) so the chair can revise and resubmit for review.
  if (kind === 'ARTICLE_PUBLISH' && refCollection === 'articles') {
    try {
      await admin.firestore().collection('articles').doc(refId).update({
        status: isApproved ? 'PUBLISHED' : 'DRAFT',
        publishedAt: isApproved ? new Date().toISOString() : null,
      });
    } catch (err) {
      console.error(`onApprovalResolved: Failed to update article ${refId} status:`, err);
    }
  }

  // ── Side-effect: lifecycle action decision → sync the action doc ──
  // Completion (archiving the member on the effective date) stays an explicit
  // step in the Lifecycle panel; approval only authorises it.
  if (refCollection === 'membershipActions' && (kind === 'RESIGNATION' || kind === 'CLUB_TRANSFER')) {
    try {
      await admin.firestore().collection('membershipActions').doc(refId).update({
        status: isApproved ? 'APPROVED' : 'REJECTED',
      });
    } catch (err) {
      console.error(`onApprovalResolved: Failed to sync membershipAction ${refId}:`, err);
    }
  }

  // ── Side-effect: MEMBER_ONBOARDING approved → activate user ──
  if (isApproved && kind === 'MEMBER_ONBOARDING' && refCollection === 'members') {
    try {
      const userSnap = await admin.firestore().collection('users').doc(refId).get();
      if (userSnap.exists) {
        await userSnap.ref.update({
          verified: true,
          role: 'VIEWER',
          memberType: 'GENERAL',
          permissions: ['payments'],
        });
      }
    } catch (err) {
      console.error(`onApprovalResolved: Failed to activate user ${refId}:`, err);
    }
  }

  const approvalId = event.params.approvalId as string;

  // ── Notify requester ──
  const notifTitle = isApproved
    ? `${kind.replace(/_/g, ' ')} Approved`
    : `${kind.replace(/_/g, ' ')} Rejected`;
  const notifMessage = isApproved
    ? `"${title}" has been approved.`
    : `"${title}" has been rejected.`;

  const link = resolvedSourceLink(kind, refId, approvalId);

  await sendNotificationToUser(requestedBy, clubId, notifTitle, notifMessage, 'TRANSACTION_STATUS', link);

  // Email the requester
  const requesterSnap = await admin.firestore().collection('users').doc(requestedBy).get();
  const requesterEmail = requesterSnap.data()?.email;
  if (requesterEmail) {
    const decisionBy = (decisions || []).map((d: any) => d.name).join(', ') || 'Approver';
    const emailHtml = isApproved
      ? emailApprovalNotification(title, kind, 'APPROVED', decisionBy, baseUrl, link)
      : emailApprovalNotification(title, kind, 'REJECTED', decisionBy, baseUrl, link);
    await sendEmail(requesterEmail, notifTitle, emailHtml);
  }
});

// ─── Trigger 4: Payment / transaction created ─────────────────────────────────

export const onPaymentCreated = onDocumentCreated('payments/{paymentId}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  const paymentData = snap.data();
  if (!paymentData || paymentData.status !== 'PENDING') return;

  const { clubId, memberName, amount, description, date } = paymentData;

  const usersSnap = await admin.firestore()
    .collection('users')
    .where('clubId', '==', clubId)
    .where('verified', '==', true)
    .get();

  await Promise.all(
    usersSnap.docs.map(async (userDoc) => {
      const profile = userDoc.data();
      const canVerify =
        profile.role === 'ADMIN' ||
        profile.isExcoMember === true ||
        (profile.permissions || []).includes('manage_payments');

      if (!canVerify) return;

      await sendNotificationToUser(
        userDoc.id,
        clubId,
        'Payment Verification Required',
        `${memberName || 'A member'} logged a payment of LKR ${amount.toLocaleString()} for review.`,
        'TRANSACTION_PENDING',
        `/transactions?id=${event.params.paymentId}`
      );

      if (profile.email) {
        await sendEmail(
          profile.email,
          `Payment pending review — LKR ${amount.toLocaleString()}`,
          emailPaymentPending(memberName || 'Unknown', amount, description || '', date || '', await getClubBaseUrl(clubId), event.params.paymentId)
        );
      }
    })
  );
});

// ─── Trigger 5: Payment approved or rejected ─────────────────────────────────

export const onPaymentUpdated = onDocumentUpdated('payments/{paymentId}', async (event) => {
  const change = event.data;
  if (!change) return;
  const oldData = change.before.data();
  const newData = change.after.data();
  if (!oldData || !newData) return;

  const { status: oldStatus } = oldData;
  const { clubId, status: newStatus, amount, description, submittedBy, approvedByName, rejectionReason } = newData;

  // Only fire when transitioning out of PENDING
  if (oldStatus !== 'PENDING' || (newStatus !== 'APPROVED' && newStatus !== 'REJECTED')) return;
  if (!submittedBy) return;

  const isApproved = newStatus === 'APPROVED';
  const notifTitle = isApproved ? 'Payment Approved' : 'Payment Rejected';
  const notifMessage = isApproved
    ? `Your payment of LKR ${amount.toLocaleString()} was approved by ${approvedByName || 'checker'}.`
    : `Your payment of LKR ${amount.toLocaleString()} was rejected. Reason: ${rejectionReason || 'No reason specified'}.`;

  const [, submitterSnap, paymentBaseUrl] = await Promise.all([
    sendNotificationToUser(submittedBy, clubId, notifTitle, notifMessage, 'TRANSACTION_STATUS', `/transactions?id=${event.params.paymentId}`),
    admin.firestore().collection('users').doc(submittedBy).get(),
    getClubBaseUrl(clubId),
  ]);
  const submitterEmail = submitterSnap.data()?.email;

  if (submitterEmail) {
    if (isApproved) {
      await sendEmail(
        submitterEmail,
        `Your payment of LKR ${amount.toLocaleString()} was approved`,
        emailPaymentApproved(amount, approvedByName || 'Checker', description || '', paymentBaseUrl, event.params.paymentId)
      );
    } else {
      await sendEmail(
        submitterEmail,
        `Your payment of LKR ${amount.toLocaleString()} was rejected`,
        emailPaymentRejected(amount, rejectionReason || 'No reason specified', description || '', paymentBaseUrl, event.params.paymentId)
      );
    }
  }
});

// ─── Trigger 6: New approval request created ──────────────────────────────────

export const onApprovalCreated = onDocumentCreated('approvals/{approvalId}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  const data = snap.data();
  if (!data || data.status !== 'PENDING') return;

  const { clubId, kind, title, summary, requestedBy, requestedByName, policySnapshot } = data;
  const approvalId = event.params.approvalId;
  const baseUrl = await getClubBaseUrl(clubId);
  const approvalLink = `${baseUrl}/approvals?id=${approvalId}`;
  const kindLabel = KIND_LABELS[kind] || kind.replace(/_/g, ' ');

  // Determine eligible approvers from the policy snapshot
  let eligibleQuery: FirebaseFirestore.Query = admin.firestore()
    .collection('users')
    .where('clubId', '==', clubId)
    .where('verified', '==', true);

  const { approverType, approverRefs } = policySnapshot || {};

  // Fetch candidates based on approver type
  let candidateSnap: FirebaseFirestore.QuerySnapshot;
  if (approverType === 'SPECIFIC_USERS') {
    // Fetch specific user docs directly
    const userDocs = await Promise.all(
      (approverRefs || []).map((uid: string) =>
        admin.firestore().collection('users').doc(uid).get()
      )
    );
    await Promise.all(
      userDocs
        .filter(d => d.exists && d.id !== requestedBy)
        .map(async (userDoc) => {
          const profile = userDoc.data()!;
          await sendNotificationToUser(userDoc.id, clubId,
            `${kindLabel} Pending Your Approval`,
            `"${title}" submitted by ${requestedByName} requires your decision.`,
            'APPROVAL_REQUEST', `/approvals?id=${approvalId}`
          );
          if (profile.email) {
            await sendEmail(profile.email, `Review required: ${title}`,
              emailApprovalRequest(kindLabel, title, summary || '', requestedByName, approvalLink)
            );
          }
        })
    );
    return;
  }

  candidateSnap = await eligibleQuery.get();

  await Promise.all(
    candidateSnap.docs
      .filter(userDoc => userDoc.id !== requestedBy)
      .filter(userDoc => {
        const profile = userDoc.data();
        if (profile.role === 'ADMIN') return true;
        if (approverType === 'MEMBER_TYPE') {
          const ref = (approverRefs || [])[0];
          if (ref === 'EXCO') return profile.isExcoMember === true;
          if (ref === 'BOARD') return profile.isBoardMember === true || profile.isExcoMember === true;
          if (ref === 'GENERAL') return true;
        }
        if (approverType === 'PERMISSION') {
          return (profile.permissions || []).some((p: string) => (approverRefs || []).includes(p));
        }
        return false;
      })
      .map(async (userDoc) => {
        const profile = userDoc.data();
        await sendNotificationToUser(userDoc.id, clubId,
          `${kindLabel} Pending Your Approval`,
          `"${title}" submitted by ${requestedByName} requires your decision.`,
          'APPROVAL_REQUEST', `/approvals?id=${approvalId}`
        );
        if (profile.email) {
          await sendEmail(profile.email, `Review required: ${title}`,
            emailApprovalRequest(kindLabel, title, summary || '', requestedByName, approvalLink)
          );
        }
      })
  );
});

// ─── Password reset email template ────────────────────────────────────────────

function passwordResetEmailHtml(resetLink: string, email: string): string {
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0f172a;font-family:'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr><td align="center" style="padding:40px 20px;">
      <table width="560" style="background:#1e293b;border-radius:10px;overflow:hidden;border:1px solid #334155;">
        <tr><td style="padding:32px;background:linear-gradient(135deg,#1e293b,#0f172a);border-bottom:1px solid #334155;">
          <p style="margin:0;color:#6366f1;font-size:11px;font-weight:800;letter-spacing:4px;text-transform:uppercase;">VAULT PRO</p>
          <h1 style="margin:12px 0 0;color:#f1f5f9;font-size:24px;font-weight:900;line-height:1.2;">Password Reset Request</h1>
          <p style="margin:8px 0 0;color:#94a3b8;font-size:14px;">We received a request to reset your Vault password.</p>
        </td></tr>
        <tr><td style="padding:32px;">
          <p style="color:#94a3b8;font-size:14px;margin:0 0 8px;">Reset requested for</p>
          <p style="color:#6366f1;font-size:14px;font-weight:700;margin:0 0 28px;font-family:monospace;">${email}</p>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center" style="padding:8px 0 28px;">
              <a href="${resetLink}"
                 style="display:inline-block;background:#6366f1;color:#ffffff;text-decoration:none;font-weight:800;font-size:14px;padding:16px 40px;border-radius:8px;letter-spacing:0.5px;">
                Reset My Password
              </a>
            </td></tr>
          </table>
          <table width="100%" style="background:#0f172a;border:1px solid #334155;border-radius:8px;">
            <tr><td style="padding:20px;">
              <p style="margin:0 0 10px;color:#64748b;font-size:10px;font-weight:800;letter-spacing:3px;text-transform:uppercase;">Important</p>
              <p style="margin:0 0 6px;color:#94a3b8;font-size:13px;">⏱ This link expires in <strong style="color:#f1f5f9;">1 hour</strong></p>
              <p style="margin:0;color:#94a3b8;font-size:13px;">🔒 If you didn't request this, you can safely ignore this email.</p>
            </td></tr>
          </table>
        </td></tr>
        <tr><td style="padding:20px 32px;border-top:1px solid #334155;">
          <p style="margin:0;color:#475569;font-size:11px;text-align:center;">
            Vault Pro · Rotaract Club Management Platform<br/>
            <a href="https://vaultpro.cloud" style="color:#6366f1;text-decoration:none;">vaultpro.cloud</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

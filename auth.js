const { betterAuth } = require('better-auth');
const { drizzleAdapter } = require('better-auth/adapters/drizzle');
const { magicLink } = require('better-auth/plugins');
const { Resend } = require('resend');
const { db } = require('./db/index');
const schema = require('./db/schema');

const resend = new Resend(process.env.RESEND_API_KEY);

const auth = betterAuth({
  baseURL: process.env.BASE_URL || 'http://localhost:3000',
  secret: process.env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: 'pg',
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        await resend.emails.send({
          from: 'Distill <noreply@ingenioussoul.com>',
          to: email,
          subject: 'Your Distill sign-in link',
          html: `
            <div style="font-family:'DM Sans',sans-serif;max-width:480px;margin:0 auto;padding:40px 24px;background:#0F0F0D;color:#F4F1EB">
              <div style="font-size:22px;font-weight:600;margin-bottom:8px">Distill</div>
              <div style="font-size:15px;color:rgba(244,241,235,0.7);margin-bottom:32px">Turn what you notice into something you can build.</div>
              <a href="${url}" style="display:inline-block;background:#C4500A;color:#F7F4EE;text-decoration:none;padding:14px 28px;font-size:15px;font-weight:500;border-radius:4px">Open Distill →</a>
              <div style="margin-top:32px;font-size:12px;color:rgba(244,241,235,0.4)">This link expires in 10 minutes. If you didn't request this, you can ignore it.</div>
            </div>
          `,
        });
      },
    }),
  ],
});

module.exports = { auth };

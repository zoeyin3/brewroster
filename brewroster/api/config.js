// Vercel serverless function: hands the public Supabase settings to the browser.
// Set SUPABASE_URL and SUPABASE_ANON_KEY in Vercel > Project > Settings > Environment Variables.
// Never put the service_role key here.
module.exports = function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.status(200).json({ url: process.env.SUPABASE_URL || '', key: process.env.SUPABASE_ANON_KEY || '' });
};

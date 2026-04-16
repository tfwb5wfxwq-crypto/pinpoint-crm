const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const { contact, action, email_text } = await req.json();
    const key = Deno.env.get('ANTHROPIC_API_KEY');
    if (!key) return new Response(JSON.stringify({ error: 'No API key' }), { status: 500, headers: CORS });

    const days_inactive = contact.last_contact_date
      ? Math.floor((Date.now() - new Date(contact.last_contact_date).getTime()) / 86400000)
      : contact.first_contact_date
        ? Math.floor((Date.now() - new Date(contact.first_contact_date).getTime()) / 86400000)
        : null;

    let prompt = '';

    if (action === 'followup') {
      prompt = `You are an AI assistant for Remy Vandenhende, Managing Director & Head of Global Markets and Hedge Funds at Pinpoint Partners, a specialist executive search firm focused on capital markets talent (equities, fixed income, S&T, hedge funds).

Contact profile:
- Name: ${contact.first_name} ${contact.last_name || ''}
- Bank/Firm: ${contact.bank}
- Category: ${contact.category === 'CLIENTS' ? 'Existing client' : 'Prospect'}
- Focus: ${contact.classification || 'Both equities and fixed income'}
- Title: ${contact.title_role || 'unknown'}
- First contacted: ${contact.first_contact_date || 'not recorded'}
- Last contact: ${contact.last_contact_date || 'not recorded'}
- Follow-ups sent: ${contact.nb_follow_ups || 0}
- Reply status: ${contact.reply_status}
- Days since last contact: ${days_inactive !== null ? days_inactive + ' days' : 'unknown'}
- Notes: ${contact.notes || 'none'}

Write a short, sharp follow-up email body (3-4 sentences max) from Remy to re-engage this contact.

Rules:
No greeting, no "Dear X", no subject line. Just the body, starting directly with the first sentence.
Write in full natural sentences only. Zero bullet points, zero dashes, zero lists, zero hyphens used as separators.
Be specific to their bank and focus area (${contact.classification}).
Reference context from the notes if available, but don't make it obvious you're reading a file.
Offer something concrete: a candidate profile, market intelligence, a connection, an insight.
Warm and human tone, like a message from someone who genuinely knows them.
End with one soft call to action (a call, coffee, or quick reply).
Write in English.

Reply with ONLY the email body. No subject, no sign-off, no "Best regards", nothing else.`;

    } else if (action === 'analyze') {
      prompt = `You are an AI assistant for Remy Vandenhende at Pinpoint Partners (executive search, capital markets).

Contact: ${contact.first_name} ${contact.last_name || ''} at ${contact.bank}
Notes: ${contact.notes || 'none'}

Email received:
---
${email_text}
---

Analyze this email and reply with a JSON object (no markdown, pure JSON):
{
  "summary": "2-sentence summary of what the contact said",
  "sentiment": "positive|neutral|negative|interested|not_interested",
  "key_points": ["point 1", "point 2"],
  "suggested_action": "what Remy should do next",
  "suggested_reply": "short reply email body (3-4 sentences). Start directly with the first sentence, no greeting, no Dear, no subject line, no sign-off. Write in full natural sentences only, zero bullet points, zero dashes, zero lists. Warm and human tone.",
  "update_reply_status": true or false,
  "urgency": "high|medium|low"
}`;
    }

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await resp.json();
    const text = data.content?.[0]?.text || '';

    if (action === 'analyze') {
      try {
        const parsed = JSON.parse(text);
        return new Response(JSON.stringify(parsed), { headers: { ...CORS, 'Content-Type': 'application/json' } });
      } catch {
        return new Response(JSON.stringify({ summary: text, sentiment: 'neutral', suggested_reply: text }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
      }
    }

    return new Response(JSON.stringify({ email: text }), { headers: { ...CORS, 'Content-Type': 'application/json' } });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }
});

CREATE TABLE IF NOT EXISTS public.mail_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email text UNIQUE NOT NULL,
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.mail_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow authenticated all" ON public.mail_tokens FOR ALL TO authenticated USING (true);
CREATE POLICY "Allow anon select" ON public.mail_tokens FOR SELECT TO anon USING (true);
CREATE POLICY "Allow anon insert" ON public.mail_tokens FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Allow anon update" ON public.mail_tokens FOR UPDATE TO anon USING (true);

-- Create contacts table
CREATE TABLE IF NOT EXISTS public.contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bank text NOT NULL,
  category text NOT NULL CHECK (category IN ('CLIENTS', 'PROSPECT')),
  first_name text NOT NULL,
  last_name text,
  title_role text,
  email text UNIQUE,
  classification text CHECK (classification IN ('Equities', 'Fixed Income', 'Both')),
  first_contact_date date,
  last_contact_date date,
  nb_follow_ups integer DEFAULT 0,
  reply_status text DEFAULT 'No Reply' CHECK (reply_status IN ('Replied', 'No Reply')),
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER contacts_updated_at
  BEFORE UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Row Level Security
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anon select" ON public.contacts
  FOR SELECT TO anon USING (true);

CREATE POLICY "Allow authenticated all" ON public.contacts
  FOR ALL TO authenticated USING (true);

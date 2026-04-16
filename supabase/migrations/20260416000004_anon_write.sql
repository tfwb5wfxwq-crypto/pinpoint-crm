-- Allow anon to insert, update and delete contacts
-- (private tool, no public auth needed)
CREATE POLICY "Allow anon insert" ON public.contacts
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "Allow anon update" ON public.contacts
  FOR UPDATE TO anon USING (true);

CREATE POLICY "Allow anon delete" ON public.contacts
  FOR DELETE TO anon USING (true);

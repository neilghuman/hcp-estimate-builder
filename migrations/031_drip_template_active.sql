-- Draft/active flag for auto-reply templates. Lets us stage category-specific templates as drafts
-- (invisible to the n8n resolver) until real copy is written and the template is activated.
ALTER TABLE drip_template ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

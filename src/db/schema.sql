-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.products (
  id text NOT NULL DEFAULT 'prod-12345'::text,
  name text DEFAULT 'Lumo Peak Watch'::text,
  description text DEFAULT 'High-performance tracking meets professional elegance.'::text,
  image_url text DEFAULT 'https://lh3.googleusercontent.com/aida-public/AB6AXuCdXYOsWVIiR_AhheT0lcwIikMDN5aVFIX5nFLJrD0QykgSvYx0jxAgZWtcxKWk_iFrWLhY-p0ELBu92QXdo9Hbm3Ug4jBAEDSK2WsA92KZF6hP5F1GNFZ9azeKsMlpWkw0LvP239fslzG0i3rQsL_2LGp_3e4lom_l1WTPubKUZXrXIHVuK7jHUAjFVzO7ABlNfM6yScYT3dutgdCuKOMX645Xk_bVFmLtr6dVPM1P3yP9IQp70uV7NUW2Aa2kU5kndUnOMaibLoc'::text,
  CONSTRAINT products_pkey PRIMARY KEY (id)
);
CREATE TABLE public.product_prices (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  country text DEFAULT 'US'::text,
  currency text DEFAULT 'USD'::text,
  product_id text,
  price numeric DEFAULT '199'::numeric,
  CONSTRAINT product_prices_pkey PRIMARY KEY (id),
  CONSTRAINT product_prices_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id)
);
CREATE TABLE public.attributes (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  product_id text,
  type text,
  content jsonb,
  CONSTRAINT attributes_pkey PRIMARY KEY (id),
  CONSTRAINT attributes_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id)
);
CREATE TABLE public.products_categories (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  category_name text NOT NULL,
  product_id text NOT NULL,
  CONSTRAINT products_categories_pkey PRIMARY KEY (id),
  CONSTRAINT products_categories_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id)
);
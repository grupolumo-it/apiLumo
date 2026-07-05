CREATE OR REPLACE FUNCTION get_random_ids(
  p_table_name text, 
  p_limit int,
  p_return_column text DEFAULT 'id',
  p_filter_column text DEFAULT NULL,
  p_filter_value text DEFAULT NULL
)
RETURNS SETOF text AS $$
DECLARE
  v_query text;
BEGIN
  -- Construcción base del SELECT seguro utilizando %I para las columnas y tablas
  v_query := format('SELECT %I::text FROM %I', p_return_column, p_table_name);

  -- Si se proporciona tanto la columna de filtro como el valor, añadimos el WHERE
  IF p_filter_column IS NOT NULL AND p_filter_value IS NOT NULL THEN
    v_query := v_query || format(' WHERE %I = $2', p_filter_column);
  END IF;

  -- Añadimos el ordenamiento aleatorio y el límite
  v_query := v_query || ' ORDER BY random() LIMIT $1;';

  -- Ejecutamos pasando $1 (p_limit) y $2 (p_filter_value) mediante USING
  RETURN QUERY EXECUTE v_query USING p_limit, p_filter_value;
END;
$$ LANGUAGE plpgsql STABLE;
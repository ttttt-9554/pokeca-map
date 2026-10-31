-- v21.150: Recognize the official Pokemon card category as a valid
-- catalog-monitor target, retaining the old search route for compatibility.
-- Individual product URL restrictions and the Amenity Dream rules remain
-- identical to the previous constraint.
ALTER TABLE public.guerrilla_sale_monitor_targets
DROP CONSTRAINT IF EXISTS guerrilla_target_url_check;

ALTER TABLE public.guerrilla_sale_monitor_targets
ADD CONSTRAINT guerrilla_target_url_check CHECK (
  (
    site_key='pokemon'
    AND (
      (mode='all' AND url IN (
        'https://www.pokemoncenter-online.com/search/',
        'https://www.pokemoncenter-online.com/pokemon-card-game/'
      ))
      OR
      (mode='selected' AND url ~
        '^https://www[.]pokemoncenter-online[.]com/[0-9]{6,20}(-[A-Za-z0-9_-]+)?[.]html$')
    )
  )
  OR
  (
    site_key='amenity'
    AND (
      (mode='all' AND url='https://www.amenitydream.com/product-list')
      OR (mode='selected' AND url ~
        '^https://www[.]amenitydream[.]com/product/[0-9]+$')
    )
  )
);

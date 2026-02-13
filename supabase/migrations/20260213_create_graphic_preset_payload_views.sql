-- Preset payload helper views for graphics workflows.
-- Goal: fetch all data needed to build bridge graphics_send payloads per preset
-- without manual joins across presets/templates/sessions tables.

create or replace view public.v_graphic_preset_payload_layers as
with layer_source as (
  select
    gs.org_id,
    gs.id as session_id,
    gs.name as session_name,
    gp.id as preset_id,
    gp.name as preset_name,
    gp.preview_background as preset_preview_background,
    case when gp.duration_ms is null then null else gp.duration_ms::int end as preset_duration_ms,
    gpt.id as preset_template_id,
    gpt.category::text as template_category,
    case
      when gpt.category::text = 'lower-third' then 'lower-thirds'
      when gpt.category::text = 'overlay' then 'overlays'
      when gpt.category::text = 'slide' then 'slides'
      else gpt.category::text
    end as graphics_category,
    case
      when gpt.category::text = 'slide' then 10
      when gpt.category::text = 'overlay' then 20
      when gpt.category::text = 'lower-third' then 30
      else 0
    end as resolved_z_index,
    ogt.id as template_id,
    ogt.name as template_name,
    coalesce(ogt.config_json, '{}'::jsonb) as template_config_json,
    coalesce(ogt.values_json, '{}'::jsonb) as template_values_json,
    coalesce(gpt.values_json, '{}'::jsonb) as preset_values_json,
    coalesce(gpt.values_json, ogt.values_json, '{}'::jsonb) as selected_values_json,
    case
      when gpt.layout_json is not null then gpt.layout_json
      when gpt.category::text = 'lower-third' then jsonb_build_object('x', 0, 'y', 780, 'scale', 1)
      else jsonb_build_object('x', 0, 'y', 0, 'scale', 1)
    end as resolved_layout_json
  from public.graphic_preset_templates gpt
  join public.graphic_presets gp on gp.id = gpt.preset_id
  join public.graphic_sessions gs on gs.id = gp.session_id
  join public.org_graphic_templates ogt on ogt.id = gpt.org_graphic_template_id
)
select
  org_id,
  session_id,
  session_name,
  preset_id,
  preset_name,
  preset_preview_background,
  preset_duration_ms,
  preset_template_id,
  template_category,
  graphics_category,
  resolved_z_index,
  template_id,
  template_name,
  (graphics_category || '-' || template_id::text) as layer_id,
  resolved_layout_json as resolved_layout,
  jsonb_build_object(
    'name', coalesce(template_config_json #>> '{manifest,name}', template_name),
    'version', coalesce(template_config_json #>> '{manifest,version}', '1.0.0'),
    'type', coalesce(template_config_json #>> '{manifest,type}', template_category),
    'render', jsonb_build_object(
      'width', coalesce((template_config_json #>> '{manifest,render,width}')::int, 1920),
      'height', coalesce((template_config_json #>> '{manifest,render,height}')::int, 1080),
      'fps', coalesce((template_config_json #>> '{manifest,render,fps}')::numeric, 25),
      'background', coalesce(template_config_json #>> '{manifest,render,background}', 'transparent')
    )
  ) as resolved_manifest,
  coalesce(template_config_json ->> 'html', '') as template_html,
  coalesce(template_config_json ->> 'css', '') as template_css,
  coalesce(template_config_json -> 'schema', '{}'::jsonb) as template_schema_json,
  coalesce(template_config_json -> 'defaults', '{}'::jsonb) as template_defaults_json,
  template_values_json,
  preset_values_json,
  selected_values_json,
  (
    coalesce(template_config_json -> 'defaults', '{}'::jsonb) ||
    selected_values_json
  ) as effective_values_json,
  jsonb_build_object(
    'manifest', jsonb_build_object(
      'name', coalesce(template_config_json #>> '{manifest,name}', template_name),
      'version', coalesce(template_config_json #>> '{manifest,version}', '1.0.0'),
      'type', coalesce(template_config_json #>> '{manifest,type}', template_category),
      'render', jsonb_build_object(
        'width', coalesce((template_config_json #>> '{manifest,render,width}')::int, 1920),
        'height', coalesce((template_config_json #>> '{manifest,render,height}')::int, 1080),
        'fps', coalesce((template_config_json #>> '{manifest,render,fps}')::numeric, 25),
        'background', coalesce(template_config_json #>> '{manifest,render,background}', 'transparent')
      )
    ),
    'html', coalesce(template_config_json ->> 'html', ''),
    'css', coalesce(template_config_json ->> 'css', ''),
    'schema', coalesce(template_config_json -> 'schema', '{}'::jsonb),
    'defaults', coalesce(template_config_json -> 'defaults', '{}'::jsonb),
    'assets', '[]'::jsonb
  ) as graphics_bundle_json,
  jsonb_build_object(
    'layerId', (graphics_category || '-' || template_id::text),
    'category', graphics_category,
    'backgroundMode', preset_preview_background,
    'layout', resolved_layout_json,
    'zIndex', resolved_z_index,
    'bundle', jsonb_build_object(
      'manifest', jsonb_build_object(
        'name', coalesce(template_config_json #>> '{manifest,name}', template_name),
        'version', coalesce(template_config_json #>> '{manifest,version}', '1.0.0'),
        'type', coalesce(template_config_json #>> '{manifest,type}', template_category),
        'render', jsonb_build_object(
          'width', coalesce((template_config_json #>> '{manifest,render,width}')::int, 1920),
          'height', coalesce((template_config_json #>> '{manifest,render,height}')::int, 1080),
          'fps', coalesce((template_config_json #>> '{manifest,render,fps}')::numeric, 25),
          'background', coalesce(template_config_json #>> '{manifest,render,background}', 'transparent')
        )
      ),
      'html', coalesce(template_config_json ->> 'html', ''),
      'css', coalesce(template_config_json ->> 'css', ''),
      'schema', coalesce(template_config_json -> 'schema', '{}'::jsonb),
      'defaults', coalesce(template_config_json -> 'defaults', '{}'::jsonb),
      'assets', '[]'::jsonb
    ),
    'values', (coalesce(template_config_json -> 'defaults', '{}'::jsonb) || selected_values_json),
    'presetId', preset_id::text,
    'durationMs', preset_duration_ms
  ) as graphics_send_payload
from layer_source;

create or replace view public.v_graphic_preset_payloads as
select
  gs.org_id,
  gs.id as session_id,
  gs.name as session_name,
  gp.id as preset_id,
  gp.name as preset_name,
  gp.preview_background as preset_preview_background,
  case when gp.duration_ms is null then null else gp.duration_ms::int end as preset_duration_ms,
  coalesce(
    jsonb_agg(l.graphics_send_payload order by l.resolved_z_index asc)
      filter (where l.preset_template_id is not null),
    '[]'::jsonb
  ) as graphics_send_payloads,
  count(l.preset_template_id) as payload_layer_count
from public.graphic_presets gp
join public.graphic_sessions gs on gs.id = gp.session_id
left join public.v_graphic_preset_payload_layers l on l.preset_id = gp.id
group by
  gs.org_id,
  gs.id,
  gs.name,
  gp.id,
  gp.name,
  gp.preview_background,
  gp.duration_ms;

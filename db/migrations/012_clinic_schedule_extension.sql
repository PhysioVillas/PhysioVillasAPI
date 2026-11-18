-- T06: extends the simulated clinic schedule grid (POC).
-- Append-only. Only runs where the clinica_simulada schema exists.
-- The function is NOT executed by this migration; run `npm run extend-schedule`.
do $$
begin
  if to_regnamespace('clinica_simulada') is not null then
    execute $fn$
      create or replace function clinica_simulada.extend_schedule(p_days int default 60)
      returns int
      language plpgsql
      as $body$
      declare
        v_today date := (now() at time zone 'America/Bahia')::date;
        v_cal_max date;
        v_cap_max date;
        v_inserted int := 0;
        v_rows int;
        v_day date;
        v_offset int;
        v_months text[] := array['jan','fev','mar','abr','mai','jun','jul','ago','set','out','nov','dez'];
        v_weekdays text[] := array['Segunda','Terça','Quarta','Quinta','Sexta','Sábado','Domingo'];
      begin
        if p_days is null or p_days < 0 or p_days > 730 then
          raise exception 'p_days must be between 0 and 730';
        end if;

        select max(data) into v_cal_max from clinica_simulada.d_calendario;
        select max(data) into v_cap_max from clinica_simulada.f_capacidade;

        -- Calendar: max(data)+1 .. today + p_days. Fixed national holidays are
        -- feriado = 'Sim' and not business days; Sundays are not business days.
        insert into clinica_simulada.d_calendario
          (data, ano, mes_num, mes, ano_mes, dia_semana_num, dia_semana, semana_ano, feriado, dia_util, ate_hoje)
        select
          g.d::date,
          extract(year from g.d)::bigint,
          extract(month from g.d)::bigint,
          v_months[extract(month from g.d)::int] || '/' || to_char(g.d, 'YY'),
          (extract(year from g.d) * 100 + extract(month from g.d))::bigint,
          extract(isodow from g.d)::bigint,
          v_weekdays[extract(isodow from g.d)::int],
          extract(week from g.d)::bigint,
          case when h.is_holiday then 'Sim' else 'Não' end,
          case when h.is_holiday or extract(isodow from g.d) = 7 then 'Não' else 'Sim' end,
          case when g.d::date <= v_today then 'Sim' else 'Não' end
        from generate_series(
          coalesce(v_cal_max + 1, v_today), v_today + p_days, interval '1 day'
        ) as g(d)
        cross join lateral (
          select (to_char(g.d, 'MM-DD') in
            ('01-01','04-21','05-01','09-07','10-12','11-02','11-15','11-20','12-25')) as is_holiday
        ) h
        on conflict (data) do nothing;
        get diagnostics v_rows = row_count;
        v_inserted := v_inserted + v_rows;

        -- Capacity: business days after the last existing capacity day with no
        -- rows yet. Pattern = same weekday of the same ISO week one year earlier
        -- (364 days back); fallback = same weekday of the last 4 weeks.
        for v_day in
          select c.data
          from clinica_simulada.d_calendario c
          where c.dia_util = 'Sim'
            and c.data > coalesce(v_cap_max, date '0001-01-01')
            and c.data <= v_today + p_days
            and not exists (select 1 from clinica_simulada.f_capacidade x where x.data = c.data)
          order by c.data
        loop
          select t.o into v_offset
          from unnest(array[364, 7, 14, 21, 28]) with ordinality as t(o, ord)
          where exists (select 1 from clinica_simulada.f_capacidade x where x.data = v_day - t.o)
          order by t.ord
          limit 1;

          if v_offset is not null then
            insert into clinica_simulada.f_capacidade (data, hora, profissional_id, servico_id, vagas)
            select v_day, s.hora, s.profissional_id, s.servico_id, s.vagas
            from clinica_simulada.f_capacidade s
            where s.data = v_day - v_offset
            on conflict (data, hora, profissional_id, servico_id) do nothing;
            get diagnostics v_rows = row_count;
            v_inserted := v_inserted + v_rows;
          end if;
          v_offset := null;
        end loop;

        return v_inserted;
      end;
      $body$
    $fn$;
  end if;
end $$;

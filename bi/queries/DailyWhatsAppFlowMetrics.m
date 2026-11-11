let
    Source = PostgreSQL.Database(NeonServer, NeonDatabase),
    ReportingView = Source{[Schema = "reporting", Item = "daily_whatsapp_flow_metrics"]}[Data],
    TypedColumns = Table.TransformColumnTypes(
        ReportingView,
        {
            {"activity_date", type date},
            {"event_type", type text},
            {"step_key", type text},
            {"source", type text},
            {"event_count", Int64.Type},
            {"conversation_count", Int64.Type}
        }
    )
in
    TypedColumns

let
    Source = PostgreSQL.Database(NeonServer, NeonDatabase),
    ReportingView = Source{[Schema = "reporting", Item = "daily_message_metrics"]}[Data],
    TypedColumns = Table.TransformColumnTypes(
        ReportingView,
        {
            {"activity_date", type date},
            {"direction", type text},
            {"sent_via", type text},
            {"message_type", type text},
            {"status", type text},
            {"message_count", Int64.Type},
            {"error_count", Int64.Type}
        }
    )
in
    TypedColumns

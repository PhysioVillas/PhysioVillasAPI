let
    Source = PostgreSQL.Database(NeonServer, NeonDatabase),
    ReportingView = Source{[Schema = "reporting", Item = "daily_human_response_metrics"]}[Data],
    TypedColumns = Table.TransformColumnTypes(
        ReportingView,
        {
            {"activity_date", type date},
            {"response_count", Int64.Type},
            {"average_response_seconds", type number},
            {"median_response_seconds", type number}
        }
    )
in
    TypedColumns

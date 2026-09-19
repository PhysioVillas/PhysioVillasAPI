function notFoundHandler(_request, response) {
  response.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: 'Route not found.',
    },
  });
}

function errorHandler(error, _request, response, next) {
  if (response.headersSent) {
    return next(error);
  }

  if (error?.type === 'entity.parse.failed') {
    return response.status(400).json({
      error: {
        code: 'INVALID_JSON',
        message: 'Request body must be valid JSON.',
      },
    });
  }

  console.error('Unhandled request error.', { name: error?.name ?? 'Error' });

  return response.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error.',
    },
  });
}

export { errorHandler, notFoundHandler };

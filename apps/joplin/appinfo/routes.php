<?php
declare(strict_types=1);

return [
    'routes' => [
        // Main page
        ['name' => 'page#index', 'url' => '/', 'verb' => 'GET'],

        // REST API
        ['name' => 'api#tree',        'url' => '/api/tree',         'verb' => 'GET'],
        ['name' => 'api#note',        'url' => '/api/note/{id}',    'verb' => 'GET'],
        ['name' => 'api#createNote',  'url' => '/api/note',         'verb' => 'POST'],
        ['name' => 'api#updateNote',  'url' => '/api/note/{id}',    'verb' => 'PUT'],
        ['name' => 'api#deleteNote',  'url' => '/api/note/{id}',    'verb' => 'DELETE'],
        ['name' => 'api#search',      'url' => '/api/search',       'verb' => 'GET'],
        ['name' => 'api#reindex',     'url' => '/api/reindex',      'verb' => 'POST'],
        ['name' => 'api#setRoot',     'url' => '/api/root',         'verb' => 'POST'],
        ['name' => 'api#getRoot',     'url' => '/api/root',         'verb' => 'GET'],

        // Notebook (folder) operations
        ['name' => 'api#createFolder',          'url' => '/api/folder',                    'verb' => 'POST'],
        ['name' => 'api#renameFolder',          'url' => '/api/folder/{id}',               'verb' => 'PUT'],
        ['name' => 'api#deleteFolder',          'url' => '/api/folder/{id}',               'verb' => 'DELETE'],
        ['name' => 'api#countFolderDescendants','url' => '/api/folder/{id}/descendants',   'verb' => 'GET'],
    ],
];

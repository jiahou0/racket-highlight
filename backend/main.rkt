#lang racket/base
(require racket/runtime-path)
(define-runtime-path lexical "lexical.rkt")
(define-runtime-path semantic "semantic.rkt")
(define-runtime-path organize "organize.rkt")
(define args (current-command-line-arguments))
(unless (= (vector-length args) 1) (error 'racket-workbench "Expected worker mode"))
((dynamic-require
  (case (string->symbol (vector-ref args 0))
    [(lexical) lexical] [(semantic) semantic] [(organize) organize]
    [else (error 'racket-workbench "Unknown worker mode")])
  'main))
